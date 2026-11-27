import type { NextFunction, Request, Response } from "express"

import { env } from "../env.js"
import { log } from "../lib/logger.js"
import { ipKey, normalisedEmailKey } from "./rateLimitAuthFlows.js"
import { consumeInsured, createInsuredLimiter } from "./rateLimitShared.js"

// Admin login is the highest-value brute-force target in this codebase.
// Both limiters are "insured" (rateLimitShared.ts): a Redis outage degrades
// to a per-process in-memory cap, never to no cap — and if even that fails
// the request is rejected rather than admitted. Keyed per IP and per
// normalised email (15-min window) so rotating IPs against one admin
// account is still capped.
const adminLoginIpLimiter = createInsuredLimiter({
  keyPrefix: "admin-login",
  points: env.adminLoginRateLimitPerMin,
  durationSeconds: 60,
})

const adminLoginEmailLimiter = createInsuredLimiter({
  keyPrefix: "admin-login-email",
  points: env.adminLoginEmailRateLimitPer15Min,
  durationSeconds: 15 * 60,
})

export async function rateLimitAdminLogin(req: Request, res: Response, next: NextFunction) {
  const emailKey = normalisedEmailKey((req.body as { email?: unknown } | undefined)?.email)
  const checks: Array<[typeof adminLoginIpLimiter, string | null]> = [
    [adminLoginIpLimiter, ipKey(req)],
    [adminLoginEmailLimiter, emailKey],
  ]
  for (const [limiter, key] of checks) {
    if (!key) continue
    const rejection = await consumeInsured(limiter, key)
    if (rejection) {
      const retryAfterSeconds = Math.max(1, Math.ceil(rejection.msBeforeNext / 1000))
      log().warn({ event: "admin-login-rate-limited", rateLimiter: limiter.name, retryAfterSeconds }, "admin login rate limit exceeded")
      res.set("Retry-After", String(retryAfterSeconds))
      res.status(429).json({ ok: false, error: "Too many sign-in attempts — please wait a moment and try again." })
      return
    }
  }
  next()
}
