import type { NextFunction, Request, Response } from "express"

import { log } from "../lib/logger.js"
import { consumeInsured, createInsuredLimiter } from "./rateLimitShared.js"

// SA-01: PATCH /admin/account checks the admin's current password, so it is a
// password-guessing oracle for anyone holding a live admin cookie (a session
// left open on a shared machine). Capped per admin account with the same
// insured (never-unlimited) limiter as admin login. Keyed on the account, not
// the IP: the attacker needs that account's cookie anyway, and rotating IPs
// must not reset the budget. A constant rather than an env setting, to keep
// src/env.ts untouched; generous for a human, tight for a guesser.
export const ADMIN_ACCOUNT_CHANGE_PER_ADMIN_PER_15_MIN = 10

const perAdminLimiter = createInsuredLimiter({
  keyPrefix: "admin-account-change",
  points: ADMIN_ACCOUNT_CHANGE_PER_ADMIN_PER_15_MIN,
  durationSeconds: 15 * 60,
})

/** Must run after requireAdminAuth (keys on req.adminUserId). */
export async function rateLimitAdminAccountChange(req: Request, res: Response, next: NextFunction) {
  if (!req.adminUserId) return next()
  const rejection = await consumeInsured(perAdminLimiter, req.adminUserId)
  if (rejection) {
    const retryAfterSeconds = Math.max(1, Math.ceil(rejection.msBeforeNext / 1000))
    log().warn(
      { event: "admin-account-change-rate-limited", adminUserId: req.adminUserId, retryAfterSeconds },
      "admin account change rate limit exceeded",
    )
    res.set("Retry-After", String(retryAfterSeconds))
    res.status(429).json({ ok: false, error: "Too many attempts — please wait a few minutes and try again." })
    return
  }
  next()
}
