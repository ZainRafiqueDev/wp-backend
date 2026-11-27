import { Queue } from "bullmq"

import { env } from "../env.js"
import { redis } from "./redis.js"

export interface CrawlJobData {
  chatbotId: string
  url: string
 
  requestId?: string
}


export interface RecrawlChatbotJobData {
  chatbotId: string
}


export interface RecrawlTickJobData {
  tick: true
}

export interface ReservationSweepTickJobData {
  tick: true
}

export interface StripeInboxSweepTickJobData {
  tick: true
}

export interface RechunkLegacyTickJobData {
  tick: true
}

export interface AttachmentRetentionTickJobData {
  tick: true
}

export interface ConversationMaintenanceTickJobData {
  tick: true
}

type QueueJobData =
  | CrawlJobData
  | RecrawlChatbotJobData
  | RecrawlTickJobData
  | ReservationSweepTickJobData
  | StripeInboxSweepTickJobData
  | RechunkLegacyTickJobData
  | ConversationMaintenanceTickJobData

const crawlQueue = new Queue<QueueJobData>(env.crawlQueueName, { connection: redis })


export async function enqueueCrawlJob(data: CrawlJobData): Promise<void> {
  await crawlQueue.add("crawl-chatbot", data, {
    attempts: 1,
    removeOnComplete: 100,
    removeOnFail: 100,
  })
}

export async function enqueueRecrawlJob(data: RecrawlChatbotJobData): Promise<void> {
  await crawlQueue.add("recrawl-chatbot", data, {
    attempts: 1,
    removeOnComplete: 100,
    removeOnFail: 100,
  })
}


export async function ensureRecrawlSchedulerRegistered(): Promise<void> {
  await crawlQueue.add(
    "recrawl-tick",
    { tick: true },
    {
      repeat: { every: env.recrawlIntervalMs },
      jobId: "recrawl-scheduler",
      removeOnComplete: 10,
      removeOnFail: 10,
    },
  )
}

// Orphan-recovery sweep for the reservation ledger (tokenallocation.md §1,
// §17) — a worker crash between reserving and reconciling would otherwise
// leave a 'held' row (and the Redis capacity it represents) locked forever.
export async function ensureReservationSweepSchedulerRegistered(): Promise<void> {
  await crawlQueue.add(
    "reservation-sweep-tick",
    { tick: true },
    {
      repeat: { every: env.reservationSweepIntervalMs },
      jobId: "reservation-sweep-scheduler",
      removeOnComplete: 10,
      removeOnFail: 10,
    },
  )
}

export async function ensureStripeInboxSweepSchedulerRegistered(): Promise<void> {
  await crawlQueue.add(
    "stripe-inbox-sweep-tick",
    { tick: true },
    {
      repeat: { every: env.stripeInboxSweepIntervalMs },
      jobId: "stripe-inbox-sweep-scheduler",
      removeOnComplete: 10,
      removeOnFail: 10,
    },
  )
}

// WP-3.3: migrates one chunking_version=1 document to the new semantic
// chunker per tick — see findNextLegacyChunkDocumentId/rechunkLegacyDocument
// in documentIngestion.service.ts for why this is one-at-a-time.
export async function ensureRechunkLegacySchedulerRegistered(): Promise<void> {
  await crawlQueue.add(
    "rechunk-legacy-tick",
    { tick: true },
    {
      repeat: { every: env.rechunkLegacyIntervalMs },
      jobId: "rechunk-legacy-scheduler",
      removeOnComplete: 10,
      removeOnFail: 10,
    },
  )
}

// Phase 3 (2026-10-27): deletes expired chat attachments (object + row),
// decrements attachment_storage_usage, and nightly-recomputes it from
// chatbot_attachments (the source of truth) to correct any drift.
export async function ensureAttachmentRetentionSchedulerRegistered(): Promise<void> {
  await crawlQueue.add(
    "attachment-retention-tick",
    { tick: true },
    {
      repeat: { every: env.attachmentRetentionIntervalMs },
      jobId: "attachment-retention-scheduler",
      removeOnComplete: 10,
      removeOnFail: 10,
    },
  )
}

// WP-3.4: conversation compaction, idle-TTL expiry, and cross-session memory
// retention. All three are deliberately off the chat request path.
export async function ensureConversationMaintenanceSchedulerRegistered(): Promise<void> {
  await crawlQueue.add(
    "conversation-maintenance-tick",
    { tick: true },
    {
      repeat: { every: env.conversationMaintenanceIntervalMs },
      jobId: "conversation-maintenance-scheduler",
      removeOnComplete: 10,
      removeOnFail: 10,
    },
  )
}
