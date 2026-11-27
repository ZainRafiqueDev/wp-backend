import { createHash } from "node:crypto"

import type { NextFunction } from "express"
import { RateLimiterMemory, RateLimiterRedis, type RateLimiterRes } from "rate-limiter-flexible"

import { log } from "../lib/logger.js"
import { cacheRedis } from "../lib/redis.js"

// Single source of truth for "was this rejection a real quota breach, or
// some other error (Redis down, a network blip, a timeout)?" — every
// limiter in src/middleware/ used to duplicate this exact check inline.
// rate-limiter-flexible only attaches `msBeforeNext` to a genuine
// points-exhausted rejection; anything else (a thrown Error, a plain
// object from a broken client) is an infra failure, not a user exceeding
// their limit.
export function isRateLimiterRejection(value: unknown): value is RateLimiterRes {
  return Boolean(value && typeof value === "object" && "msBeforeNext" in value)
}

export interface RedisConsumingLimiter {
  consume(key: string): Promise<unknown>
}

/**
 * Shared control flow for every Redis-backed limiter in this codebase: a
 * real quota breach always rejects the request (`onQuotaExceeded`); any
 * other rejection is treated as an infra failure and falls through to
 * `next()` instead of a 429 — a Redis outage must never be indistinguishable
 * from a user-caused rate limit (see src/middleware/README.md).
 *
 * This does NOT change behavior for a limiter configured with its own
 * `insuranceLimiter` (rate-limiter-flexible's own in-memory fallback — see
 * rateLimitAdminLogin.ts / rateLimitPublicAttachment.ts): when Redis is
 * down, such a limiter's own internals already either admit the request or
 * reject with a real `msBeforeNext` from the in-memory fallback, so
 * `consume()` resolves or rejects exactly as if nothing were wrong — this
 * function only ever sees the raw "Redis down, no fallback configured" case
 * for a limiter that doesn't have one.
 */
export async function consumeOrFailOpen(
  limiter: RedisConsumingLimiter,
  key: string,
  next: NextFunction,
  onQuotaExceeded: (rejection: RateLimiterRes) => void,
  onInfraError?: (err: unknown) => void,
): Promise<void> {
  try {
    await limiter.consume(key)
    next()
  } catch (rejection) {
    if (!isRateLimiterRejection(rejection)) {
      onInfraError?.(rejection)
      next()
      return
    }
    onQuotaExceeded(rejection)
  }
}

// ---------------------------------------------------------------------------
// Insured (never-unlimited) limiters — CS-09 (B10-013, B05-015, S3-011).
//
// Security-sensitive limiters (login, admin login, OTP send/verify, password
// forgot/reset, signup, verify-email, resend-verification) must NOT become
// unlimited during a Redis outage. Each one is a RateLimiterRedis with an
// `insuranceLimiter` (rate-limiter-flexible's built-in in-memory fallback,
// the same pattern rateLimitAdminLogin.ts / rateLimitPublicAttachment.ts
// already used), plus `rejectIfRedisNotReady` so a disconnected client fails
// over immediately instead of waiting for ioredis retries. If an infra error
// still escapes consume() (both layers failed, or a mocked consume), the
// caller explicitly consumes the same in-memory limiter; if THAT also fails,
// the request is rejected (fail closed) rather than admitted.
//
// Memory bound: the in-memory fallback hashes every key into a fixed number
// of buckets, so an attacker rotating emails/IPs during an outage can create
// at most INSURANCE_KEY_BUCKETS entries per limiter (each also expires after
// the limiter's own window). A bucket collision only ever makes the fallback
// stricter, never looser.
// ---------------------------------------------------------------------------

export const INSURANCE_KEY_BUCKETS = 65_536

function insuranceBucket(key: string | number): string {
  const digest = createHash("sha256").update(String(key)).digest()
  return String(digest.readUInt32BE(0) % INSURANCE_KEY_BUCKETS)
}

/** RateLimiterMemory whose key space is bounded (see INSURANCE_KEY_BUCKETS). */
export class BoundedMemoryLimiter extends RateLimiterMemory {
  override consume(key: string | number, pointsToConsume?: number, options?: { [key: string]: unknown }) {
    return super.consume(insuranceBucket(key), pointsToConsume, options)
  }
}

export interface InsuredLimiter {
  readonly name: string
  readonly redis: RedisConsumingLimiter
  readonly insurance: RedisConsumingLimiter
  readonly durationSeconds: number
}

export interface InsuredLimiterOptions {
  keyPrefix: string
  points: number
  durationSeconds: number
  /** Defaults to the shared cacheRedis client; tests may inject a broken one. */
  storeClient?: unknown
}

export function createInsuredLimiter(opts: InsuredLimiterOptions): InsuredLimiter {
  const insurance = new BoundedMemoryLimiter({ points: opts.points, duration: opts.durationSeconds })
  const redis = new RateLimiterRedis({
    storeClient: opts.storeClient ?? cacheRedis,
    keyPrefix: opts.keyPrefix,
    points: opts.points,
    duration: opts.durationSeconds,
    insuranceLimiter: insurance,
    rejectIfRedisNotReady: true,
  })
  return { name: opts.keyPrefix, redis, insurance, durationSeconds: opts.durationSeconds }
}

/**
 * Consume one point. Resolves `null` when admitted, or the rejection to send
 * as a 429. Never admits a request without some limiter having counted it.
 */
export async function consumeInsured(limiter: InsuredLimiter, key: string): Promise<RateLimiterRes | null> {
  try {
    await limiter.redis.consume(key)
    return null
  } catch (rejection) {
    if (isRateLimiterRejection(rejection)) return rejection
    log().warn(
      { event: "rate-limiter-redis-unavailable", rateLimiter: limiter.name, err: errMessage(rejection) },
      "rate limiter store unavailable, using in-memory fallback",
    )
  }
  try {
    await limiter.insurance.consume(key)
    return null
  } catch (rejection) {
    if (isRateLimiterRejection(rejection)) return rejection
    log().error(
      { event: "rate-limiter-unavailable", rateLimiter: limiter.name, err: errMessage(rejection) },
      "rate limiter and in-memory fallback both failed, failing closed",
    )
    return { msBeforeNext: limiter.durationSeconds * 1000 } as RateLimiterRes
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
