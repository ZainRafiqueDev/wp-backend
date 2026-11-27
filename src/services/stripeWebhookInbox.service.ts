import type Stripe from "stripe"

import { env } from "../env.js"
import { pool } from "../lib/db.js"
import { AppError } from "../lib/errors.js"
import { log } from "../lib/logger.js"
import { runWithSystemContext } from "../lib/tenantContext.js"
import { cacheRedis } from "../lib/redis.js"
import { processStripeWebhookEvent } from "./billing.service.js"

export type StripeInboxMetricName =
  | "stripe.inbox_received"
  | "stripe.inbox_duplicate"
  | "stripe.inbox_processed"
  | "stripe.inbox_failed"
  | "stripe.inbox_processing"
  | "stripe.inbox_replayed"

export type StripeInboxListStatus = "unprocessed" | "processing" | "failed" | "processed"

export interface StripeInboxHealth {
  available: boolean
  unprocessed: number
  failed: number
  processing: number
  oldestAgeSeconds: number | null
  duplicates: number
  replayCount: number
  avgProcessingMs: number | null
}

export interface StripeInboxEventSummary {
  stripeEventId: string
  type: string
  receivedAt: string
  lastAttemptAt: string | null
  processedAt: string | null
  attempts: number
  lastError: string | null
}

export interface StripeInboxListQuery {
  status?: StripeInboxListStatus
  type?: string
  customer?: string
  limit?: number
  offset?: number
}

export interface StripeInboxListResult {
  events: StripeInboxEventSummary[]
  total: number
  limit: number
  offset: number
}

function metricDay(): string {
  return new Date().toISOString().slice(0, 10)
}

async function incrementStripeInboxMetric(name: StripeInboxMetricName, fields: Record<string, unknown> = {}): Promise<void> {
  log().info({ event: name, metric: name, ...fields }, name)
  try {
    const key = `metric:${name}:${metricDay()}`
    await cacheRedis.incr(key)
    await cacheRedis.expire(key, 3 * 24 * 60 * 60)
  } catch {
    // Metrics must never take the webhook path down.
  }
}

async function readDayCounter(name: StripeInboxMetricName): Promise<number> {
  try {
    const raw = await cacheRedis.get(`metric:${name}:${metricDay()}`)
    return Number(raw) || 0
  } catch {
    return 0
  }
}

async function recordProcessingDurationMs(elapsedMs: number): Promise<void> {
  try {
    const day = metricDay()
    await cacheRedis.incrby(`metric:stripe.inbox_duration_ms:${day}`, Math.max(0, Math.round(elapsedMs)))
    await cacheRedis.incr(`metric:stripe.inbox_duration_n:${day}`)
    await cacheRedis.expire(`metric:stripe.inbox_duration_ms:${day}`, 3 * 24 * 60 * 60)
    await cacheRedis.expire(`metric:stripe.inbox_duration_n:${day}`, 3 * 24 * 60 * 60)
  } catch {
    // ignore
  }
}

function requireDbPool() {
  if (!pool) throw new AppError(503, "Database is not configured. Set DATABASE_URL and JWT_SECRET.")
  return pool
}

/**
 * Persist a signature-verified Stripe event, then process it inline.
 *
 * Phase 1 uses verify → persist → process → 200 so entitlement is written
 * before Stripe is told the event is accepted. Phase 3 should switch to
 * verify → persist → 200 → worker process (see docs/STRIPE_WEBHOOK_INBOX.md).
 */
export type StripeInboxOutcome = "duplicate" | "processed" | "in_progress"

/**
 * How long one processor holds the claim on an inbox row. A processor that
 * crashes mid-event releases it implicitly when the lease runs out, so the
 * replay job (or a Stripe retry) can pick the event up again.
 */
export const STRIPE_INBOX_CLAIM_LEASE_SECONDS = 120

export async function receiveVerifiedStripeEvent(
  event: Stripe.Event,
  options: { replay?: boolean } = {},
): Promise<StripeInboxOutcome> {
  return runWithSystemContext(() => receiveVerifiedStripeEventUnscoped(event, options))
}

async function receiveVerifiedStripeEventUnscoped(
  event: Stripe.Event,
  options: { replay?: boolean } = {},
): Promise<StripeInboxOutcome> {
  if (!event.id) throw new AppError(400, "Stripe event is missing an id.")

  if (!pool) {
    await processStripeWebhookEvent(event)
    return "processed"
  }

  const db = requireDbPool()
  const inserted = await db.query<{ stripe_event_id: string }>(
    `insert into stripe_webhook_events (stripe_event_id, type, payload)
     values ($1, $2, $3::jsonb)
     on conflict (stripe_event_id) do nothing
     returning stripe_event_id`,
    [event.id, event.type, JSON.stringify(event)],
  )

  if (inserted.rowCount) {
    await incrementStripeInboxMetric("stripe.inbox_received", { stripeEventId: event.id, type: event.type })
  }
  if (options.replay) {
    await incrementStripeInboxMetric("stripe.inbox_replayed", { stripeEventId: event.id, type: event.type })
  }

  // CS-13: claim the row atomically. Only the caller whose update returns
  // the row runs the handler; a concurrent delivery of the same event id
  // (Stripe retry racing the original, replay job racing a live delivery)
  // sees no row and does not process it a second time.
  const claimed = await db.query<{ stripe_event_id: string }>(
    `update stripe_webhook_events
     set attempts = attempts + 1, last_attempt_at = now(),
         locked_until = now() + ($2 * interval '1 second')
     where stripe_event_id = $1
       and processed_at is null
       and (locked_until is null or locked_until < now())
     returning stripe_event_id`,
    [event.id, STRIPE_INBOX_CLAIM_LEASE_SECONDS],
  )

  if (!claimed.rowCount) {
    const { rows } = await db.query<{ processed_at: Date | null }>(
      "select processed_at from stripe_webhook_events where stripe_event_id = $1",
      [event.id],
    )
    const row = rows[0]
    if (!row) throw new AppError(503, "Failed to persist Stripe webhook event.")
    await incrementStripeInboxMetric("stripe.inbox_duplicate", { stripeEventId: event.id, type: event.type })
    return row.processed_at ? "duplicate" : "in_progress"
  }

  await incrementStripeInboxMetric("stripe.inbox_processing", { stripeEventId: event.id, type: event.type })
  const startedAt = Date.now()
  try {
    await processStripeWebhookEvent(event)
    await db.query(
      `update stripe_webhook_events
       set processed_at = now(), last_error = null, locked_until = null
       where stripe_event_id = $1`,
      [event.id],
    )
    await incrementStripeInboxMetric("stripe.inbox_processed", { stripeEventId: event.id, type: event.type })
    return "processed"
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await db.query(
      `update stripe_webhook_events set last_error = $2, locked_until = null where stripe_event_id = $1`,
      [event.id, message.slice(0, 2000)],
    )
    await incrementStripeInboxMetric("stripe.inbox_failed", { stripeEventId: event.id, type: event.type })
    throw err
  } finally {
    await recordProcessingDurationMs(Date.now() - startedAt)
  }
}

export async function getStripeInboxHealth(): Promise<StripeInboxHealth> {
  return runWithSystemContext(() => getStripeInboxHealthUnscoped())
}

async function getStripeInboxHealthUnscoped(): Promise<StripeInboxHealth> {
  const empty: StripeInboxHealth = {
    available: false,
    unprocessed: 0,
    failed: 0,
    processing: 0,
    oldestAgeSeconds: null,
    duplicates: 0,
    replayCount: 0,
    avgProcessingMs: null,
  }
  if (!pool) return empty

  try {
    const replayDelaySeconds = Math.max(1, env.stripeInboxReplayDelaySeconds)
    const { rows } = await pool.query<{
      unprocessed: string
      failed: string
      processing: string
      oldest: Date | null
    }>(
      `select
         count(*) filter (where processed_at is null)::text as unprocessed,
         count(*) filter (where processed_at is null and last_error is not null)::text as failed,
         count(*) filter (
           where processed_at is null
             and last_attempt_at is not null
             and last_attempt_at >= now() - ($1 * interval '1 second')
         )::text as processing,
         min(received_at) filter (where processed_at is null) as oldest
       from stripe_webhook_events`,
      [replayDelaySeconds],
    )
    const unprocessed = Number(rows[0]?.unprocessed ?? 0)
    const failed = Number(rows[0]?.failed ?? 0)
    const processing = Number(rows[0]?.processing ?? 0)
    const oldest = rows[0]?.oldest ? new Date(rows[0].oldest) : null
    const oldestAgeSeconds = oldest ? Math.max(0, Math.floor((Date.now() - oldest.getTime()) / 1000)) : null

    if (unprocessed > 0) {
      log().warn({ event: "stripe.inbox_unprocessed", unprocessed, oldestAgeSeconds }, "stripe webhook inbox has unprocessed events")
    }
    if (oldestAgeSeconds !== null && oldestAgeSeconds > env.stripeInboxAgeAlertSeconds) {
      log().warn(
        { event: "stripe.inbox_age_seconds", oldestAgeSeconds, unprocessed },
        "stripe webhook inbox event older than alert threshold",
      )
    }

    const [duplicates, replayCount, durationMsRaw, durationNRaw] = await Promise.all([
      readDayCounter("stripe.inbox_duplicate"),
      readDayCounter("stripe.inbox_replayed"),
      cacheRedis.get(`metric:stripe.inbox_duration_ms:${metricDay()}`).catch(() => null),
      cacheRedis.get(`metric:stripe.inbox_duration_n:${metricDay()}`).catch(() => null),
    ])
    const durationN = Number(durationNRaw) || 0
    const avgProcessingMs = durationN > 0 ? Math.round(Number(durationMsRaw || 0) / durationN) : null

    return {
      available: true,
      unprocessed,
      failed,
      processing,
      oldestAgeSeconds,
      duplicates,
      replayCount,
      avgProcessingMs,
    }
  } catch (err) {
    log().warn({ err: err instanceof Error ? err.message : String(err) }, "stripe inbox health query failed")
    return empty
  }
}

function mapInboxRow(row: {
  stripe_event_id: string
  type: string
  received_at: Date
  last_attempt_at: Date | null
  processed_at: Date | null
  attempts: number
  last_error: string | null
}): StripeInboxEventSummary {
  return {
    stripeEventId: row.stripe_event_id,
    type: row.type,
    receivedAt: row.received_at.toISOString(),
    lastAttemptAt: row.last_attempt_at ? row.last_attempt_at.toISOString() : null,
    processedAt: row.processed_at ? row.processed_at.toISOString() : null,
    attempts: row.attempts,
    lastError: row.last_error,
  }
}

export async function listStripeInboxEvents(query: StripeInboxListQuery = {}): Promise<StripeInboxListResult> {
  const db = requireDbPool()
  const limit = Math.min(200, Math.max(1, query.limit ?? 50))
  const offset = Math.max(0, query.offset ?? 0)
  const replayDelaySeconds = Math.max(1, env.stripeInboxReplayDelaySeconds)

  const filters: string[] = []
  const values: unknown[] = []

  if (query.status === "processed") {
    filters.push("processed_at is not null")
  } else if (query.status === "failed") {
    filters.push("processed_at is null and last_error is not null")
  } else if (query.status === "unprocessed") {
    filters.push("processed_at is null")
  } else if (query.status === "processing") {
    values.push(replayDelaySeconds)
    filters.push(
      `processed_at is null and last_attempt_at is not null and last_attempt_at >= now() - ($${values.length} * interval '1 second')`,
    )
  }

  if (query.type) {
    values.push(query.type)
    filters.push(`type = $${values.length}`)
  }

  if (query.customer) {
    values.push(query.customer)
    filters.push(
      `(payload #>> '{data,object,customer}' = $${values.length} or payload #>> '{data,object,customer,id}' = $${values.length})`,
    )
  }

  const where = filters.length > 0 ? `where ${filters.join(" and ")}` : ""
  const countResult = await db.query<{ n: string }>(
    `select count(*)::text as n from stripe_webhook_events ${where}`,
    values,
  )
  const limitPlaceholder = values.length + 1
  const offsetPlaceholder = values.length + 2
  const { rows } = await db.query<{
    stripe_event_id: string
    type: string
    received_at: Date
    last_attempt_at: Date | null
    processed_at: Date | null
    attempts: number
    last_error: string | null
  }>(
    `select stripe_event_id, type, received_at, last_attempt_at, processed_at, attempts, last_error
     from stripe_webhook_events
     ${where}
     order by received_at desc
     limit $${limitPlaceholder} offset $${offsetPlaceholder}`,
    [...values, limit, offset],
  )

  return {
    events: rows.map(mapInboxRow),
    total: Number(countResult.rows[0]?.n ?? 0),
    limit,
    offset,
  }
}

/**
 * Replays persisted events that never reached processed_at (process crash after insert).
 * Only rows whose last_attempt_at (or received_at) is older than STRIPE_INBOX_REPLAY_DELAY.
 */
export async function reprocessUnprocessedStripeWebhookEvents(limit = 20): Promise<number> {
  return runWithSystemContext(() => reprocessUnprocessedStripeWebhookEventsUnscoped(limit))
}

async function reprocessUnprocessedStripeWebhookEventsUnscoped(limit = 20): Promise<number> {
  if (!pool) return 0

  const replayDelaySeconds = Math.max(1, env.stripeInboxReplayDelaySeconds)
  const { rows } = await pool.query<{ payload: Stripe.Event }>(
    `select payload
     from stripe_webhook_events
     where processed_at is null
       and coalesce(last_attempt_at, received_at) < now() - ($2 * interval '1 second')
     order by received_at
     limit $1`,
    [limit, replayDelaySeconds],
  )

  let recovered = 0
  for (const row of rows) {
    try {
      const outcome = await receiveVerifiedStripeEvent(row.payload, { replay: true })
      if (outcome !== "in_progress") recovered += 1
    } catch (err) {
      log().error(
        { err: err instanceof Error ? err.message : String(err), stripeEventId: row.payload?.id },
        "stripe inbox recovery replay failed",
      )
    }
  }
  return recovered
}

/** Deletes processed inbox rows (payload included) older than STRIPE_INBOX_RETENTION_DAYS. */
export async function purgeExpiredStripeWebhookEvents(): Promise<number> {
  return runWithSystemContext(() => purgeExpiredStripeWebhookEventsUnscoped())
}

async function purgeExpiredStripeWebhookEventsUnscoped(): Promise<number> {
  if (!pool || env.stripeInboxRetentionDays <= 0) return 0
  const { rowCount } = await pool.query(
    `delete from stripe_webhook_events
     where processed_at is not null
       and processed_at < now() - ($1 * interval '1 day')`,
    [env.stripeInboxRetentionDays],
  )
  const deleted = rowCount ?? 0
  if (deleted > 0) {
    log().info({ deleted, retentionDays: env.stripeInboxRetentionDays }, "purged expired stripe inbox rows")
  }
  return deleted
}
