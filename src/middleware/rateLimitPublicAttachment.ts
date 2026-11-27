import type { NextFunction, Request, Response } from "express"
import { RateLimiterMemory, RateLimiterRedis } from "rate-limiter-flexible"

import { env } from "../env.js"
import { log } from "../lib/logger.js"
import { cacheRedis } from "../lib/redis.js"
import { consumeOrFailOpen } from "./rateLimitShared.js"

// Per-IP daily cap (decision 6: "20 per IP per day") — a rolling 24h
// window, same RateLimiterRedis shape as rateLimitPublic.ts's per-minute
// chat limiter, just a longer duration. The per-conversation cap (10) is a
// real COUNT against chatbot_attachments in chatAttachments.service.ts —
// durable and exact, not a Redis approximation — rather than a second
// limiter here; a conversation can easily outlive a 24h Redis TTL.
//
// insuranceLimiter: unlike most limiters in this file's family, attachment
// uploads carry real storage/malware-scan cost per request — worth an
// in-memory per-process fallback (same reasoning as rateLimitAdminLogin.ts)
// so a Redis outage degrades to a per-process cap instead of no cap at all.
const ipDailyLimiter = new RateLimiterRedis({
  storeClient: cacheRedis,
  keyPrefix: "attachment-ip-daily",
  points: env.attachmentMaxPerIpPerDay,
  duration: 24 * 60 * 60,
  insuranceLimiter: new RateLimiterMemory({
    points: env.attachmentMaxPerIpPerDay,
    duration: 24 * 60 * 60,
  }),
})

function chatbotIdParam(req: Request): string {
  const value = req.params.chatbotId
  return Array.isArray(value) ? value[0] : value
}

export async function rateLimitPublicAttachment(req: Request, res: Response, next: NextFunction) {
  const key = `${chatbotIdParam(req)}:${req.ip}`
  await consumeOrFailOpen(
    ipDailyLimiter,
    key,
    next,
    (rejection) => {
      const retryAfterSeconds = Math.max(1, Math.ceil(rejection.msBeforeNext / 1000))
      log().warn({ event: "attachment-rate-limited", chatbotId: chatbotIdParam(req), retryAfterSeconds }, "attachment upload rate limit exceeded")
      res.set("Retry-After", String(retryAfterSeconds))
      res.status(429).json({
        ok: false,
        error: "Too many file uploads from this network today — please try again tomorrow.",
        retryAfterSeconds,
      })
    },
    (err) => {
      // Reaches here only if Redis AND the in-memory insuranceLimiter both
      // failed — not a real quota breach, fail open, same reasoning as
      // every other public rate limiter in this codebase.
      log().warn(
        { event: "attachment-rate-limiter-unavailable", chatbotId: chatbotIdParam(req), err: err instanceof Error ? err.message : String(err) },
        "attachment rate limiter unavailable (Redis and in-memory fallback both failed), failing open",
      )
    },
  )
}
