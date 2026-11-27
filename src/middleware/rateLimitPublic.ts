import type { NextFunction, Request, Response } from "express"
import { RateLimiterRedis } from "rate-limiter-flexible"

import { env } from "../env.js"
import { AppError } from "../lib/errors.js"
import { log } from "../lib/logger.js"
import { cacheRedis } from "../lib/redis.js"
import { BoundedMemoryLimiter, consumeOrFailOpen } from "./rateLimitShared.js"


const primaryLimiter = new RateLimiterRedis({
  storeClient: cacheRedis,
  keyPrefix: "public-chat",
  points: env.publicChatRateLimitPerMin,
  duration: 60,
  // CS-09: a Redis outage degrades to a per-instance in-memory cap instead
  // of unlimited public chat. Still fail-open (consumeOrFailOpen) if even
  // the fallback errors — the widget must not go dark over infra.
  insuranceLimiter: new BoundedMemoryLimiter({ points: env.publicChatRateLimitPerMin, duration: 60 }),
  rejectIfRedisNotReady: true,
})


const strictLimiter = new RateLimiterRedis({
  storeClient: cacheRedis,
  keyPrefix: "public-chat-strict",
  points: env.publicChatRateLimitStrictPerMin,
  duration: 60,
})

function chatbotIdParam(req: Request): string {
  const value = req.params.chatbotId
  return Array.isArray(value) ? value[0] : value
}

function limitKey(req: Request): string {
  return `${chatbotIdParam(req)}:${req.ip}`
}

const CONCURRENCY_REDIS_TIMEOUT_MS = 1500

function withRedisTimeout<T>(promise: Promise<T>): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error("public chat concurrency Redis timeout")), CONCURRENCY_REDIS_TIMEOUT_MS)
    }),
  ])
}

const ACQUIRE_CONCURRENCY_SLOT_LUA = `
redis.call("ZREMRANGEBYSCORE", KEYS[1], "-inf", ARGV[1])
local count = redis.call("ZCARD", KEYS[1])
if count >= tonumber(ARGV[3]) then
  return {0, count}
end
redis.call("ZADD", KEYS[1], ARGV[2], ARGV[4])
redis.call("EXPIRE", KEYS[1], tonumber(ARGV[5]))
return {1, count + 1}
`

const REFRESH_CONCURRENCY_SLOT_LUA = `
if redis.call("ZSCORE", KEYS[1], ARGV[2]) then
  redis.call("ZADD", KEYS[1], ARGV[1], ARGV[2])
  redis.call("EXPIRE", KEYS[1], tonumber(ARGV[3]))
  return 1
end
return 0
`

export async function rateLimitPublicChat(req: Request, res: Response, next: NextFunction) {
  await consumeOrFailOpen(
    primaryLimiter,
    limitKey(req),
    next,
    (rejection) => {
      const retryAfterSeconds = Math.max(1, Math.ceil(rejection.msBeforeNext / 1000))
      log().warn({ event: "public-chat-rate-limited", chatbotId: chatbotIdParam(req), retryAfterSeconds }, "public chat rate limit exceeded")
      res.set("Retry-After", String(retryAfterSeconds))
      res.status(429).json({
        ok: false,
        error: "Too many messages — please wait a moment and try again.",
        retryAfterSeconds,
      })
    },
    (err) => {
      // Redis/network error, not a real quota breach — fail open rather than
      // going dark on every visitor's chat widget during a Redis outage.
      log().warn(
        { event: "public-chat-rate-limiter-unavailable", chatbotId: chatbotIdParam(req), err: err instanceof Error ? err.message : String(err) },
        "public chat rate limiter unavailable, failing open",
      )
    },
  )
}

export function observePublicChat(req: Request, res: Response, next: NextFunction) {
  const startedAt = performance.now()
  let emitted = false
  const emit = (connectionOutcome: "finished" | "closed") => {
    if (emitted) return
    emitted = true
    log().info(
      {
        event: "public-chat-completed",
        chatbotId: chatbotIdParam(req),
        statusCode: res.statusCode,
        latencyMs: Math.round(performance.now() - startedAt),
        connectionOutcome,
        aiGenerated: res.locals.aiGenerated,
        gateReason: res.locals.gateReason,
      },
      "public chat request completed",
    )
  }
  res.once("finish", () => emit("finished"))
  res.once("close", () => emit("closed"))
  next()
}

/**
 * Bounded per-chatbot concurrency prevents one busy tenant from occupying all
 * provider and Node connections. Redis makes the limit work across AWS
 * instances; the TTL releases capacity after a crashed process.
 */
export async function limitPublicChatConcurrency(req: Request, res: Response, next: NextFunction) {
  const key = `public-chat-concurrency:${chatbotIdParam(req)}`
  const token = crypto.randomUUID()
  let acquired = false
  let heartbeat: ReturnType<typeof setInterval> | undefined

  try {
    const now = Date.now()
    const expiresAt = now + env.publicChatConcurrencySlotTtlSeconds * 1000
    const result = await withRedisTimeout(
      cacheRedis.eval(
        ACQUIRE_CONCURRENCY_SLOT_LUA,
        1,
        key,
        String(now),
        String(expiresAt),
        String(env.publicChatMaxConcurrentPerChatbot),
        token,
        String(env.publicChatConcurrencySlotTtlSeconds + 1),
      ),
    ) as [number, number]
    const admitted = Number(result[0]) === 1
    const count = Number(result[1])
    if (!admitted) {
      log().warn(
        { event: "public-chat-concurrency-rejected", chatbotId: chatbotIdParam(req), concurrent: count },
        "public chat concurrency limit exceeded",
      )
      res.set("Retry-After", "2")
      res.status(503).json({ ok: false, error: "This chatbot is busy — please try again in a moment." })
      return
    }
    acquired = true
    const heartbeatMs = Math.max(1_000, Math.floor(env.publicChatConcurrencySlotTtlSeconds * 1000 / 3))
    heartbeat = setInterval(() => {
      const refreshedExpiry = Date.now() + env.publicChatConcurrencySlotTtlSeconds * 1000
      void cacheRedis
        .eval(
          REFRESH_CONCURRENCY_SLOT_LUA,
          1,
          key,
          String(refreshedExpiry),
          token,
          String(env.publicChatConcurrencySlotTtlSeconds + 1),
        )
        .catch(() => {})
    }, heartbeatMs)
    heartbeat.unref()
  } catch (err) {
    // Fail closed: after a Redis timeout the Lua command may still complete,
    // so proceeding could exceed the configured ceiling.
    log().error(
      { event: "public-chat-concurrency-unavailable", err: err instanceof Error ? err.message : String(err) },
      "public chat concurrency control unavailable",
    )
    res.set("Retry-After", "2")
    res.status(503).json({ ok: false, error: "This chatbot is temporarily unavailable — please try again." })
    return
  }

  let released = false
  const release = () => {
    if (!acquired || released) return
    released = true
    if (heartbeat) clearInterval(heartbeat)
    void cacheRedis.zrem(key, token).catch(() => {})
  }
  res.once("finish", release)
  res.once("close", release)
  next()
}


export async function consumeStrictPublicChatLimit(key: string): Promise<void> {
  try {
    await strictLimiter.consume(key)
  } catch {
    throw new AppError(429, "Too many messages from an unverified source — please wait a moment and try again.")
  }
}
