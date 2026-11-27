
import { Queue } from "bullmq"

import { env } from "../env.js"
import { redis } from "./redis.js"

export interface CommerceWebhookProcessJobData {
  chatbotId: string
  eventId: string
}

export interface PaymentReconciliationTickJobData {
  tick: true
}


export interface CatalogSyncJobData {
  chatbotId: string
}

type CommerceQueueJobData = CommerceWebhookProcessJobData | PaymentReconciliationTickJobData | CatalogSyncJobData

const commerceQueue = new Queue<CommerceQueueJobData>(env.commerceQueueName, { connection: redis })

export async function enqueueCommerceWebhookProcessing(data: CommerceWebhookProcessJobData): Promise<void> {
  await commerceQueue.add("process-webhook-event", data, { attempts: 3, backoff: { type: "exponential", delay: 5000 }, removeOnComplete: 200, removeOnFail: 200 })
}

export async function enqueueCatalogSync(data: CatalogSyncJobData): Promise<void> {
  await commerceQueue.add("sync-catalog", data, { attempts: 2, backoff: { type: "exponential", delay: 10000 }, removeOnComplete: 50, removeOnFail: 50 })
}


export async function ensurePaymentReconciliationSchedulerRegistered(): Promise<void> {
  await commerceQueue.add(
    "payment-reconciliation-tick",
    { tick: true },
    { repeat: { every: env.paymentReconciliationIntervalMs }, jobId: "payment-reconciliation-scheduler", removeOnComplete: 10, removeOnFail: 10 },
  )
}
