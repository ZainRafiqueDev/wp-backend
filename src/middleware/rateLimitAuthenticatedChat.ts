import type { NextFunction, Request, Response } from "express"
import { RateLimiterRedis } from "rate-limiter-flexible"

import { env } from "../env.js"
import { verifyAccessToken } from "../lib/auth.js"
import { log } from "../lib/logger.js"
import { cacheRedis } from "../lib/redis.js"
import { consumeOrFailOpen } from "./rateLimitShared.js"
import { getBearerToken } from "./requireAuth.js"


const authenticatedChatLimiter = new RateLimiterRedis({
  storeClient: cacheRedis,
  keyPrefix: "authed-chat",
  points: env.authenticatedChatRateLimitPerMin,
  duration: 60,
})


export async function rateLimitAuthenticatedChat(req: Request, res: Response, next: NextFunction) {
  const userId = verifyAccessToken(getBearerToken(req))
  if (!userId) {
    return res.status(401).json({ ok: false, error: "Please sign in again." })
  }

  await consumeOrFailOpen(
    authenticatedChatLimiter,
    userId,
    next,
    (rejection) => {
      const retryAfterSeconds = Math.ceil(rejection.msBeforeNext / 1000)
      log().warn({ userId, retryAfterSeconds, rateLimiter: "authenticated-chat" }, "rate limit rejection")
      res.set("Retry-After", String(retryAfterSeconds))
      res.status(429).json({
        ok: false,
        error: "Too many messages — please wait a moment and try again.",
        retryAfterSeconds,
      })
    },
    (err) => {
      // Redis/network error, not a real quota breach — fail open rather than
      // silencing dashboard chat for every user during a Redis outage.
      log().warn(
        { userId, err: err instanceof Error ? err.message : String(err), rateLimiter: "authenticated-chat" },
        "rate limiter unavailable, failing open",
      )
    },
  )
}
