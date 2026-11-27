import { Worker, type Job } from "bullmq"

import { env, assertProductionGuards } from "./env.js"
import { pool } from "./lib/db.js"
import { baseLogger, log } from "./lib/logger.js"
import {
  ensureAttachmentRetentionSchedulerRegistered,
  ensureConversationMaintenanceSchedulerRegistered,
  ensureRecrawlSchedulerRegistered,
  ensureRechunkLegacySchedulerRegistered,
  ensureReservationSweepSchedulerRegistered,
  ensureStripeInboxSweepSchedulerRegistered,
  enqueueRecrawlJob,
  type AttachmentRetentionTickJobData,
  type ConversationMaintenanceTickJobData,
  type CrawlJobData,
  type RecrawlChatbotJobData,
  type RecrawlTickJobData,
  type ReservationSweepTickJobData,
  type StripeInboxSweepTickJobData,
} from "./lib/queue.js"
import {
  ensureDocumentIngestSweepRegistered,
  type DocumentIngestJobData,
  type DocumentIngestSweepTickData,
} from "./lib/ingestQueue.js"
import {
  backfillDocumentChunkTsvectors,
  findNextLegacyChunkDocumentId,
  processPersistedDocument,
  rechunkLegacyDocument,
  reembedMismatchedDocumentChunks,
  requeueStaleProcessingDocuments,
} from "./services/documentIngestion.service.js"
import { reembedMismatchedProductEmbeddings } from "./services/productCatalog.service.js"
import { redis } from "./lib/redis.js"
import { runWithRequestId } from "./lib/requestContext.js"
import { runWithSystemContext, runWithTenantContext } from "./lib/tenantContext.js"
import { runCrawlJob } from "./services/chatbot.service.js"
import { runConversationMaintenanceTick } from "./services/conversation.service.js"
import { listRecrawlCandidateChatbotIds, runIncrementalRecrawl } from "./services/recrawl.service.js"
import { sweepExpiredReservations } from "./services/usage.service.js"
import { runBillingLifecycleTick } from "./services/billing.service.js"
import { runAttachmentRetentionTick } from "./services/chatAttachments.service.js"
import { purgeExpiredStripeWebhookEvents, reprocessUnprocessedStripeWebhookEvents } from "./services/stripeWebhookInbox.service.js"
import {
  ensurePaymentReconciliationSchedulerRegistered,
  type CatalogSyncJobData,
  type CommerceWebhookProcessJobData,
  type PaymentReconciliationTickJobData,
} from "./lib/commerceQueue.js"
import { processCommerceWebhookEvent } from "./services/commerceWebhookProcessing.service.js"
import { runPaymentReconciliation } from "./services/paymentReconciliation.service.js"
import { getDecryptedWooCommerceCredentials } from "./services/commerceCredentials.service.js"
import { syncProductCatalog } from "./services/productCatalog.service.js"

if (!pool) {
  throw new Error("DATABASE_URL/JWT_SECRET must be set for the crawl worker (same as the API process).")
}
const db = pool

type WorkerJobData =
  | CrawlJobData
  | RecrawlChatbotJobData
  | RecrawlTickJobData
  | ReservationSweepTickJobData
  | StripeInboxSweepTickJobData
  | ConversationMaintenanceTickJobData
  | AttachmentRetentionTickJobData

assertProductionGuards()
void import("./services/modelCosts.service.js").then((mod) => mod.refreshModelCostCache()).catch(() => undefined)

const worker = new Worker<WorkerJobData>(
  env.crawlQueueName,
  async (job: Job<WorkerJobData>) => {
  
    const requestId = job.name === "crawl-chatbot" ? (job.data as CrawlJobData).requestId : undefined
    await runWithRequestId(requestId || `job-${job.id}`, async () => {
      if (job.name === "crawl-chatbot") {
        const data = job.data as CrawlJobData
        log().info({ chatbotId: data.chatbotId, url: data.url }, "crawl job started")
        await runWithTenantContext({ scope: "worker", chatbotId: data.chatbotId }, () => runCrawlJob(data.chatbotId, data.url))
        return
      }

      if (job.name === "recrawl-chatbot") {
        const data = job.data as RecrawlChatbotJobData
        const outcome = await runWithTenantContext({ scope: "worker", chatbotId: data.chatbotId }, () =>
          runIncrementalRecrawl(data.chatbotId),
        )
        log().info({ ...outcome }, "scheduled incremental recrawl finished")
        return
      }

      if (job.name === "recrawl-tick") {

        const chatbotIds = await runWithSystemContext(() => listRecrawlCandidateChatbotIds())
        for (const chatbotId of chatbotIds) {
          await enqueueRecrawlJob({ chatbotId })
        }
        log().info({ candidateCount: chatbotIds.length }, "recrawl scheduler tick fanned out")
        return
      }

      if (job.name === "reservation-sweep-tick") {
        await runWithSystemContext(() => sweepExpiredReservations())
        return
      }

      if (job.name === "stripe-inbox-sweep-tick") {
        const recovered = await runWithSystemContext(() => reprocessUnprocessedStripeWebhookEvents())
        if (recovered > 0) {
          log().info({ recovered }, "stripe inbox sweep replayed unprocessed events")
        }
        const purged = await runWithSystemContext(() => purgeExpiredStripeWebhookEvents())
        if (purged > 0) {
          log().info({ purged }, "stripe inbox sweep purged expired events")
        }
        const lifecycle = await runWithSystemContext(() => runBillingLifecycleTick())
        if (lifecycle.held > 0 || lifecycle.reminded > 0) {
          log().info(lifecycle, "billing lifecycle tick placed holds or sent renewal alerts")
        }
        return
      }

      if (job.name === "rechunk-legacy-tick") {
        const documentId = await runWithSystemContext(() => findNextLegacyChunkDocumentId())
        if (!documentId) return
        try {
          const result = await runWithSystemContext(() => rechunkLegacyDocument(documentId))
          log().info({ documentId, ...result }, "rechunk-legacy-tick: migrated one document to semantic chunking")
        } catch (err) {
          log().warn(
            { documentId, err: err instanceof Error ? err.message : String(err) },
            "rechunk-legacy-tick: failed to re-chunk document, will retry next tick",
          )
        }
        return
      }

      if (job.name === "attachment-retention-tick") {
        const result = await runWithSystemContext(() => runAttachmentRetentionTick())
        if (result.deleted > 0) {
          log().info(result, "attachment retention tick")
        }
        return
      }

      if (job.name === "conversation-maintenance-tick") {
        const result = await runWithSystemContext(() => runConversationMaintenanceTick())
        if (result.compacted > 0 || result.expired > 0 || result.memoryPurged > 0) {
          log().info(result, "conversation maintenance tick")
        }
        return
      }

      log().warn({ jobName: job.name }, "unrecognized job name, skipping")
    })
  },
  {
    connection: redis,
    concurrency: env.crawlWorkerConcurrency,
  },
)

worker.on("completed", (job) => {
  baseLogger.info({ jobName: job.name, jobId: job.id }, "job completed")
})

worker.on("failed", (job, err) => {
  baseLogger.error({ jobName: job?.name ?? "?", jobId: job?.id, err: err.message }, "job failed")
})


type CommerceWorkerJobData = CommerceWebhookProcessJobData | PaymentReconciliationTickJobData

const commerceWorker = new Worker<CommerceWorkerJobData>(
  env.commerceQueueName,
  async (job: Job<CommerceWorkerJobData>) => {
    await runWithRequestId(`job-${job.id}`, async () => {
      if (job.name === "process-webhook-event") {
        const data = job.data as CommerceWebhookProcessJobData
        await runWithTenantContext({ scope: "worker", chatbotId: data.chatbotId }, () =>
          processCommerceWebhookEvent(data.chatbotId, data.eventId),
        )
        return
      }
      if (job.name === "payment-reconciliation-tick") {
        await runWithSystemContext(() => runPaymentReconciliation())
        return
      }
      if (job.name === "sync-catalog") {
        const data = job.data as CatalogSyncJobData
        await runWithTenantContext({ scope: "worker", chatbotId: data.chatbotId }, async () => {
          const creds = await getDecryptedWooCommerceCredentials(data.chatbotId)
          if (!creds) {
            log().warn({ chatbotId: data.chatbotId }, "catalog sync skipped: no WooCommerce credentials configured (store may have been disconnected since this job was enqueued)")
            return
          }
          const count = await syncProductCatalog(data.chatbotId, creds)
          log().info({ chatbotId: data.chatbotId, productCount: count }, "product catalog synced")
        })
        return
      }
      log().warn({ jobName: job.name }, "unrecognized commerce job name, skipping")
    })
  },
  { connection: redis, concurrency: env.commerceWorkerConcurrency },
)

commerceWorker.on("completed", (job) => {
  baseLogger.info({ jobName: job.name, jobId: job.id }, "commerce job completed")
})

commerceWorker.on("failed", (job, err) => {
  baseLogger.error({ jobName: job?.name ?? "?", jobId: job?.id, err: err.message }, "commerce job failed")
})

type IngestWorkerJobData = DocumentIngestJobData | DocumentIngestSweepTickData

const ingestWorker = new Worker<IngestWorkerJobData>(
  env.documentIngestQueueName,
  async (job: Job<IngestWorkerJobData>) => {
    await runWithRequestId(
      job.name === "document-ingest" ? (job.data as DocumentIngestJobData).requestId || `job-${job.id}` : `job-${job.id}`,
      async () => {
        if (job.name === "document-ingest") {
          const data = job.data as DocumentIngestJobData
          await runWithTenantContext({ scope: "worker", chatbotId: data.chatbotId }, () =>
            processPersistedDocument(data.documentId, data.chatbotId),
          )
          return
        }
        if (job.name === "document-ingest-sweep-tick") {
          await runWithSystemContext(async () => {
            const recovered = await requeueStaleProcessingDocuments()
            if (recovered > 0) {
              log().info({ recovered }, "document ingest sweep requeued stale processing rows")
            }
            const backfilled = await backfillDocumentChunkTsvectors()
            if (backfilled > 0) {
              log().info({ backfilled }, "document chunk tsvector backfill wrote lexical search documents")
            }
            if (env.embeddingReembedOnSweep) {
              const reembeddedChunks = await reembedMismatchedDocumentChunks()
              const reembeddedProducts = await reembedMismatchedProductEmbeddings()
              if (reembeddedChunks > 0 || reembeddedProducts > 0) {
                log().info({ reembeddedChunks, reembeddedProducts }, "embedding identity cutover rewrote stale vectors")
              }
            }
          })
          return
        }
        log().warn({ jobName: job.name }, "unrecognized ingest job name, skipping")
      },
    )
  },
  { connection: redis, concurrency: env.documentIngestWorkerConcurrency },
)

ingestWorker.on("completed", (job) => {
  baseLogger.info({ jobName: job.name, jobId: job.id }, "ingest job completed")
})

ingestWorker.on("failed", (job, err) => {
  baseLogger.error({ jobName: job?.name ?? "?", jobId: job?.id, err: err.message }, "ingest job failed")
})

async function shutdown() {
  baseLogger.info("worker shutting down")
  await worker.close()
  await commerceWorker.close()
  await ingestWorker.close()
  await redis.quit()
  await db.end()
  process.exit(0)
}

process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)


await ensureRecrawlSchedulerRegistered()

await ensurePaymentReconciliationSchedulerRegistered()

await ensureReservationSweepSchedulerRegistered()
await ensureStripeInboxSweepSchedulerRegistered()
await ensureRechunkLegacySchedulerRegistered()
await ensureConversationMaintenanceSchedulerRegistered()
await ensureDocumentIngestSweepRegistered()
await ensureAttachmentRetentionSchedulerRegistered()

baseLogger.info(
  { queue: env.crawlQueueName, concurrency: env.crawlWorkerConcurrency, recrawlIntervalMs: env.recrawlIntervalMs },
  "worker listening",
)
baseLogger.info(
  { queue: env.commerceQueueName, concurrency: env.commerceWorkerConcurrency, paymentReconciliationIntervalMs: env.paymentReconciliationIntervalMs },
  "commerce worker listening",
)
baseLogger.info(
  { queue: env.documentIngestQueueName, concurrency: env.documentIngestWorkerConcurrency },
  "document ingest worker listening",
)
