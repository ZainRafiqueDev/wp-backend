import { Queue } from "bullmq"

import { env } from "../env.js"
import { pool } from "./db.js"
import { log } from "./logger.js"
import { cacheRedis } from "./redis.js"

export type IngestMetricName =
  | "ingest.queue_depth"
  | "ingest.processing_age"
  | "ingest.failed"
  | "ingest.scan_denied"
  | "ingest.scan_error"

export async function incrementIngestMetric(
  name: IngestMetricName,
  fields: Record<string, unknown> = {},
): Promise<void> {
  log().info({ event: name, metric: name, ...fields }, name)
  try {
    const day = new Date().toISOString().slice(0, 10)
    const key = `metric:${name}:${day}`
    await cacheRedis.incr(key)
    await cacheRedis.expire(key, 3 * 24 * 60 * 60)
  } catch {
    // Metrics must never take ingest down.
  }
}

export async function observeIngestQueueDepth(queue: Queue): Promise<void> {
  try {
    const counts = await queue.getJobCounts("wait", "active", "delayed")
    const depth = (counts.wait || 0) + (counts.active || 0) + (counts.delayed || 0)
    await incrementIngestMetric("ingest.queue_depth", { depth, ...counts })
  } catch {
    // ignore
  }
}

export async function observeIngestProcessingAge(): Promise<void> {
  if (!pool) return
  try {
    const { rows } = await pool.query<{ age_ms: string }>(
      `select coalesce(extract(epoch from (now() - min(coalesce(updated_at, created_at)))) * 1000, 0)::text as age_ms
       from chatbot_documents where status = 'processing'`,
    )
    await incrementIngestMetric("ingest.processing_age", { ageMs: Number(rows[0]?.age_ms || 0) })
  } catch {
    // ignore
  }
}

export function ingestWorkerConcurrency(): number {
  return env.documentIngestWorkerConcurrency
}
