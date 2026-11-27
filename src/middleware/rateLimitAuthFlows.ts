import { createHash } from "node:crypto"

import type { NextFunction, Request, Response } from "express"

import { env } from "../env.js"
import { verifyAccessToken } from "../lib/auth.js"
import { log } from "../lib/logger.js"
import { consumeInsured, createInsuredLimiter, type InsuredLimiter } from "./rateLimitShared.js"
import { getBearerToken } from "./requireAuth.js"

// Every limiter here is "insured" (rateLimitShared.ts): a Redis outage
// degrades to a per-instance in-memory cap, never to unlimited (B10-013,
// B05-015, S3-011). Login, OTP, password-forgot and signup are keyed per IP
// AND per normalised email, so rotating IPs against one account is still
// capped (the per-email window is longer — 15 min — because it is the one
// an IP-rotating attacker hits). Trade-off: the per-email bucket counts
// attempts, not only failures, so a flood aimed at one address can delay
// that address's own sign-in for up to one window; it cannot be used to
// lock accounts permanently.

const MINUTE = 60
const PER_EMAIL_WINDOW_SECONDS = 15 * 60

function ipLimiter(keyPrefix: string, points: number): InsuredLimiter {
  return createInsuredLimiter({ keyPrefix, points, durationSeconds: MINUTE })
}

function windowLimiter(keyPrefix: string, points: number): InsuredLimiter {
  return createInsuredLimiter({ keyPrefix, points, durationSeconds: PER_EMAIL_WINDOW_SECONDS })
}

const limiters = {
  otpSendIp: ipLimiter("otp-send", env.otpSendRateLimitPerMin),
  otpSendEmail: windowLimiter("otp-send-email", env.otpSendEmailRateLimitPer15Min),
  otpVerifyIp: ipLimiter("otp-verify", env.otpVerifyRateLimitPerMin),
  otpVerifyEmail: windowLimiter("otp-verify-email", env.otpVerifyEmailRateLimitPer15Min),
  passwordForgotIp: ipLimiter("password-forgot", env.passwordForgotRateLimitPerMin),
  passwordForgotEmail: windowLimiter("password-forgot-email", env.passwordForgotEmailRateLimitPer15Min),
  passwordResetIp: ipLimiter("password-reset", env.passwordResetRateLimitPerMin),
  loginIp: ipLimiter("login", env.loginRateLimitPerMin),
  loginEmail: windowLimiter("login-email", env.loginEmailRateLimitPer15Min),
  signupIp: ipLimiter("signup", env.signupRateLimitPerMin),
  signupEmail: windowLimiter("signup-email", env.signupEmailRateLimitPer15Min),
  verifyEmailIp: ipLimiter("verify-email", env.verifyEmailRateLimitPerMin),
  resendVerificationIp: ipLimiter("resend-verification", env.resendVerificationRateLimitPerMin),
  resendVerificationUser: windowLimiter("resend-verification-user", env.resendVerificationUserRateLimitPer15Min),
  publicFormIp: ipLimiter("public-form", env.publicFormRateLimitPerMin),
}

type KeyFn = (req: Request) => string | null

/** req.ip is only proxy-derived when TRUST_PROXY_HOPS > 0 (see src/app.ts). */
export const ipKey: KeyFn = (req) => req.ip || "unknown"

/**
 * Lowercased, trimmed, NFKC-normalised email, hashed — fixed-length keys,
 * and no plaintext addresses in Redis. Runs before validateBody, so a missing
 * or non-string email is skipped here (validation rejects it right after,
 * and the per-IP rule still counted the request).
 */
export function normalisedEmailKey(email: unknown): string | null {
  if (typeof email !== "string") return null
  const normalised = email.normalize("NFKC").trim().toLowerCase()
  if (!normalised) return null
  return createHash("sha256").update(normalised).digest("hex")
}

const emailKey: KeyFn = (req) => normalisedEmailKey((req.body as { email?: unknown } | undefined)?.email)

const userKey: KeyFn = (req) => verifyAccessToken(getBearerToken(req))

interface Rule {
  limiter: InsuredLimiter
  key: KeyFn
}

function authLimit(rules: Rule[], message: string) {
  return async function rateLimitAuthRoute(req: Request, res: Response, next: NextFunction) {
    for (const rule of rules) {
      const key = rule.key(req)
      if (!key) continue
      const rejection = await consumeInsured(rule.limiter, key)
      if (rejection) {
        const retryAfterSeconds = Math.max(1, Math.ceil(rejection.msBeforeNext / 1000))
        log().warn({ event: "auth-rate-limited", rateLimiter: rule.limiter.name, retryAfterSeconds }, "auth rate limit exceeded")
        res.set("Retry-After", String(retryAfterSeconds))
        res.status(429).json({ ok: false, error: message })
        return
      }
    }
    next()
  }
}

export const rateLimitOtpSend = authLimit(
  [
    { limiter: limiters.otpSendIp, key: ipKey },
    { limiter: limiters.otpSendEmail, key: emailKey },
  ],
  "Too many code requests — please wait a moment and try again.",
)

export const rateLimitOtpVerify = authLimit(
  [
    { limiter: limiters.otpVerifyIp, key: ipKey },
    { limiter: limiters.otpVerifyEmail, key: emailKey },
  ],
  "Too many verification attempts — please wait a moment and try again.",
)

export const rateLimitPasswordForgot = authLimit(
  [
    { limiter: limiters.passwordForgotIp, key: ipKey },
    { limiter: limiters.passwordForgotEmail, key: emailKey },
  ],
  "Too many reset requests — please wait a moment and try again.",
)

// Reset bodies carry a long single-use token, not an email; per-IP caps
// guessing and flooding.
export const rateLimitPasswordReset = authLimit(
  [{ limiter: limiters.passwordResetIp, key: ipKey }],
  "Too many reset attempts — please wait a moment and try again.",
)

export const rateLimitLogin = authLimit(
  [
    { limiter: limiters.loginIp, key: ipKey },
    { limiter: limiters.loginEmail, key: emailKey },
  ],
  "Too many sign-in attempts — please wait a moment and try again.",
)

export const rateLimitSignup = authLimit(
  [
    { limiter: limiters.signupIp, key: ipKey },
    { limiter: limiters.signupEmail, key: emailKey },
  ],
  "Too many sign-up attempts — please wait a moment and try again.",
)

export const rateLimitVerifyEmail = authLimit(
  [{ limiter: limiters.verifyEmailIp, key: ipKey }],
  "Too many verification attempts — please wait a moment and try again.",
)

// Mounted after requireAuth; the per-user rule only applies to a valid
// access token (an invalid one is rejected by the controller anyway).
export const rateLimitResendVerification = authLimit(
  [
    { limiter: limiters.resendVerificationIp, key: ipKey },
    { limiter: limiters.resendVerificationUser, key: userKey },
  ],
  "Too many verification emails requested — please wait a few minutes and try again.",
)

// Audit 2026-11-27: anonymous form posts (leads, contact, trial, waitlist,
// demo chat). One shared per-IP bucket; these are low-volume human forms.
export const rateLimitPublicForm = authLimit(
  [{ limiter: limiters.publicFormIp, key: ipKey }],
  "Too many submissions — please wait a moment and try again.",
)
