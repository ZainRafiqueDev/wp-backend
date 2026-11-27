import { env } from "../env.js"
import { AppError } from "./errors.js"
import { observeIngestQueueDepth } from "./ingestMetrics.js"
import { log } from "./logger.js"
import { redis } from "./redis.js"
import { Queue } from "bullmq"

export type DocumentIngestJobData = {
  documentId: string
  chatbotId: string
  requestId?: string
  resumeFromIndex?: number
}

export type DocumentIngestSweepTickData = {
  tick: true
}

const ingestQueue = new Queue<DocumentIngestJobData | DocumentIngestSweepTickData>(env.documentIngestQueueName, {
  connection: redis,
})

export function documentIngestQueue(): Queue<DocumentIngestJobData | DocumentIngestSweepTickData> {
  return ingestQueue
}

export async function ingestQueueDepth(): Promise<number> {
  const counts = await ingestQueue.getJobCounts("wait", "active", "delayed")
  return (counts.wait || 0) + (counts.active || 0) + (counts.delayed || 0)
}

export async function enqueueDocumentIngestJob(data: DocumentIngestJobData): Promise<void> {
  const depth = await ingestQueueDepth().catch(() => 0)
  if (depth > env.documentIngestBackpressureDepth) {
    log().warn(
      { event: "queue_backpressure_triggered", metric: "ingest.queue_backpressure", depth },
      "document ingest queue backpressure",
    )
    throw new AppError(
      429,
      "Document processing is temporarily delayed. Please try again in a few minutes.",
    )
  }
  await ingestQueue.add("document-ingest", data, {
    attempts: 3,
    backoff: { type: "exponential", delay: 2 * 60 * 1000 },
    removeOnComplete: 100,
    removeOnFail: false,
  })
  await observeIngestQueueDepth(ingestQueue)
  void import("../services/alerts.service.js").then((mod) => mod.maybeAlertQueueDepth(depth + 1)).catch(() => undefined)
}

export async function ensureDocumentIngestSweepRegistered(): Promise<void> {
  await ingestQueue.add(
    "document-ingest-sweep-tick",
    { tick: true },
    {
      repeat: { every: Math.max(60_000, Math.min(env.documentIngestStaleProcessingMs, 10 * 60 * 1000)) },
      jobId: "document-ingest-sweep-scheduler",
      removeOnComplete: 10,
      removeOnFail: 10,
    },
  )
}
