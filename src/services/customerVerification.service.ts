import { RateLimiterMemory, RateLimiterRedis } from "rate-limiter-flexible"

import { verifyCustomerSessionToken } from "../lib/auth.js"
import { AppError } from "../lib/errors.js"
import { log } from "../lib/logger.js"
import { cacheRedis } from "../lib/redis.js"
import { isRateLimiterRejection } from "../middleware/rateLimitShared.js"
import { customerBelongsToChatbot, getCustomerIdentity } from "./customerIdentity.service.js"
import { sendOtp, verifyOtp } from "./otp.service.js"

/**
 * CS-04 (VER-02): proof of email ownership for the public chat graphs.
 *
 * A typed email is a claim, not an identity. Before the Bookly or commerce
 * graph reads or changes anything tied to an existing customer (appointments,
 * orders, booking numbers, queued notifications) the visitor must prove they
 * control that email, either with a one-time code sent to it (the existing
 * ORDER_ACCESS OTP in otp.service.ts) or with the signed customer session
 * token that /auth/otp/verify already issues.
 *
 * The chat path has no request IP inside the graph, so the IP-keyed
 * /auth/otp/* middleware limits don't apply; these per-email and per-session
 * limits do, on top of otp.service's own resend cooldown and per-code
 * attempt cap. Each limiter has an in-memory insurance fallback so a Redis
 * outage degrades to a per-process cap rather than none.
 */

export const CHAT_OTP_PURPOSE = "ORDER_ACCESS" as const

const WINDOW_SECONDS = 15 * 60
export const CHAT_OTP_SEND_PER_EMAIL = 3
export const CHAT_OTP_SEND_PER_SESSION = 5
export const CHAT_OTP_VERIFY_PER_EMAIL = 10
export const CHAT_OTP_VERIFY_PER_SESSION = 10

function limiter(keyPrefix: string, points: number) {
  return new RateLimiterRedis({
    storeClient: cacheRedis,
    keyPrefix,
    points,
    duration: WINDOW_SECONDS,
    insuranceLimiter: new RateLimiterMemory({ points, duration: WINDOW_SECONDS }),
  })
}

const sendPerEmail = limiter("chat-otp-send-email", CHAT_OTP_SEND_PER_EMAIL)
const sendPerSession = limiter("chat-otp-send-session", CHAT_OTP_SEND_PER_SESSION)
const verifyPerEmail = limiter("chat-otp-verify-email", CHAT_OTP_VERIFY_PER_EMAIL)
const verifyPerSession = limiter("chat-otp-verify-session", CHAT_OTP_VERIFY_PER_SESSION)

/** false only on a genuine quota breach; infra errors fail open (the DB-side caps still hold). */
async function withinLimit(l: RateLimiterRedis, key: string): Promise<boolean> {
  try {
    await l.consume(key)
    return true
  } catch (err) {
    if (isRateLimiterRejection(err)) return false
    log().warn({ err: err instanceof Error ? err.message : String(err) }, "chat otp limiter unavailable, failing open")
    return true
  }
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

/**
 * - sent: a fresh code was emailed (or would be — same for unknown addresses)
 * - cooldown: a code for this address was requested moments ago; no new one
 * - limited: too many code requests for this address or this chat
 * - failed: the code couldn't be issued (infrastructure problem)
 * None of these depend on whether the address has a customer, bookings or orders.
 */
export type SendOutcome = "sent" | "cooldown" | "limited" | "failed"

export async function startChatEmailVerification(
  chatbotId: string,
  email: string,
  sessionKey: string,
  logCtx: Record<string, unknown> = {},
): Promise<SendOutcome> {
  const normalized = normalizeEmail(email)
  const emailOk = await withinLimit(sendPerEmail, normalized)
  const sessionOk = await withinLimit(sendPerSession, sessionKey)
  if (!emailOk || !sessionOk) {
    log().warn({ ...logCtx, chatbotId }, "chat email verification: send rate limit reached")
    return "limited"
  }
  try {
    await sendOtp({ email: normalized, purpose: CHAT_OTP_PURPOSE, chatbotId })
    return "sent"
  } catch (err) {
    if (err instanceof AppError && err.status === 429) return "cooldown"
    log().error({ ...logCtx, chatbotId, err: err instanceof Error ? err.message : String(err) }, "chat email verification: code not sent")
    return "failed"
  }
}

/** Pulls a 6-digit code out of a reply like "123456", "123 456" or "code: 123456". */
export function extractVerificationCode(reply: string): string | null {
  const digits = reply.replace(/\D/g, "")
  return digits.length === 6 ? digits : null
}

export type ConfirmOutcome = { status: "verified"; customerId: string } | { status: "rejected" } | { status: "limited" }

/**
 * Checks a code against the most recent ORDER_ACCESS OTP for this email and
 * chatbot. Verified only when the code is right AND the resulting identity
 * belongs to this chatbot and carries that same email.
 */
export async function confirmChatEmailVerification(
  chatbotId: string,
  email: string,
  code: string,
  sessionKey: string,
  logCtx: Record<string, unknown> = {},
): Promise<ConfirmOutcome> {
  const normalized = normalizeEmail(email)
  const emailOk = await withinLimit(verifyPerEmail, normalized)
  const sessionOk = await withinLimit(verifyPerSession, sessionKey)
  if (!emailOk || !sessionOk) {
    log().warn({ ...logCtx, chatbotId }, "chat email verification: verify rate limit reached")
    return { status: "limited" }
  }
  try {
    const result = await verifyOtp({ email: normalized, purpose: CHAT_OTP_PURPOSE, code, chatbotId })
    const customerId = result.customerId
    if (!customerId) return { status: "rejected" }
    if (!(await customerBelongsToChatbot(customerId, chatbotId))) return { status: "rejected" }
    const identity = await getCustomerIdentity(customerId)
    if (!identity?.email || normalizeEmail(identity.email) !== normalized) return { status: "rejected" }
    return { status: "verified", customerId }
  } catch (err) {
    log().info({ ...logCtx, chatbotId, err: err instanceof Error ? err.message : String(err) }, "chat email verification: code rejected")
    return { status: "rejected" }
  }
}

/**
 * Resolves the widget's signed customer session token (issued by
 * /auth/otp/verify) into a verified customer for this chatbot, or null.
 */
export async function verifiedCustomerFromSessionToken(
  chatbotId: string,
  customerToken: string | undefined | null,
): Promise<{ customerId: string; email: string } | null> {
  if (!customerToken) return null
  const session = verifyCustomerSessionToken(customerToken)
  if (!session || session.chatbotId !== chatbotId) return null
  if (!(await customerBelongsToChatbot(session.customerId, chatbotId))) return null
  const identity = await getCustomerIdentity(session.customerId)
  if (!identity?.email) return null
  return { customerId: session.customerId, email: normalizeEmail(identity.email) }
}
