import { randomInt } from "node:crypto"

import { env } from "../env.js"
import { signCustomerSessionToken, signOtpProofToken } from "../lib/auth.js"
import { pool } from "../lib/db.js"
import { sendEmail } from "../lib/email.js"
import { AppError } from "../lib/errors.js"
import { setTenantContext } from "../lib/tenantContext.js"
import { createNotification, hashToken } from "./notification.service.js"
import {
  findCustomerIdentity,
  promoteVerificationLevel,
  resolveCustomerIdentity,
} from "./customerIdentity.service.js"

export type OtpPurpose = "EMAIL_VERIFY" | "ORDER_ACCESS" | "SENSITIVE_ACTION"

export type SendOtpInput = {
  email: string
  purpose: OtpPurpose
  chatbotId?: string
  customerId?: string
}

export type VerifyOtpInput = {
  email: string
  purpose: OtpPurpose
  code: string
  chatbotId?: string
  customerId?: string
}

function requireDbPool() {
  if (!pool) throw new AppError(503, "Database is not configured. Set DATABASE_URL and JWT_SECRET.")
  return pool
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

/** Cryptographically secure 6-digit code (000000–999999). */
export function generateOtpCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0")
}

function otpExpiresAt(): Date {
  return new Date(Date.now() + env.otpTtlMinutes * 60 * 1000)
}

/**
 * Always returns the same client-facing shape so callers (and attackers)
 * cannot tell whether an account or customer row existed.
 */
const SEND_OK_MESSAGE = "If that email is eligible, a verification code has been sent."

export async function sendOtp(input: SendOtpInput): Promise<{ ok: true; message: string }> {
  const db = requireDbPool()
  const email = normalizeEmail(input.email)
  const purpose = input.purpose
  setTenantContext({
    scope: "auth",
    userEmail: email,
    chatbotId: input.chatbotId,
  })

  // Resend cooldown for the same email+purpose (DB-backed — works without Redis).
  const { rows: recent } = await db.query<{ created_at: Date }>(
    `select created_at from auth_otps
     where email = $1 and purpose = $2
     order by created_at desc
     limit 1`,
    [email, purpose],
  )
  const last = recent[0]
  if (last && Date.now() - last.created_at.getTime() < env.otpResendCooldownSeconds * 1000) {
    throw new AppError(429, "Please wait a moment before requesting another code.")
  }

  let userId: string | null = null
  const chatbotId: string | null = input.chatbotId?.trim() || null
  let customerId: string | null = input.customerId?.trim() || null
  let shouldSend = false

  if (purpose === "EMAIL_VERIFY") {
    const { rows } = await db.query<{ id: string; email_verified: boolean; is_active: boolean }>(
      "select id, email_verified, is_active from users where email = $1",
      [email],
    )
    const user = rows[0]
    if (user && user.is_active !== false && !user.email_verified) {
      userId = user.id
      shouldSend = true
    }
  } else if (purpose === "ORDER_ACCESS" || purpose === "SENSITIVE_ACTION") {
    if (!chatbotId) {
      throw new AppError(400, "chatbotId is required for this verification purpose.")
    }
    const { rows: bots } = await db.query<{ id: string }>("select id from chatbots where id = $1", [chatbotId])
    if (!bots[0]) {
      // Same generic success — do not leak chatbot existence to public callers.
      return { ok: true, message: SEND_OK_MESSAGE }
    }
    // CS-04: look up, never create — a code request alone must not leave a
    // customer_identities row behind for an arbitrary address. The identity
    // is created only once the code is verified (see verifyOtp).
    const identity = await findCustomerIdentity(chatbotId, email)
    customerId = identity?.id ?? null
    shouldSend = true
  }

  if (!shouldSend) {
    return { ok: true, message: SEND_OK_MESSAGE }
  }

  const code = generateOtpCode()
  const expires = otpExpiresAt()

  // Invalidate prior unused codes for this email+purpose (+ tenant scope).
  await db.query(
    `update auth_otps
     set verified_at = coalesce(verified_at, now())
     where email = $1 and purpose = $2 and verified_at is null
       and ($3::uuid is null or chatbot_id is not distinct from $3)
       and ($4::uuid is null or customer_id is not distinct from $4)`,
    [email, purpose, chatbotId, customerId],
  )

  await db.query(
    `insert into auth_otps
       (email, otp_hash, purpose, expires_at, max_attempts, user_id, chatbot_id, customer_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      email,
      hashToken(code),
      purpose,
      expires,
      env.otpMaxAttempts,
      userId,
      chatbotId,
      customerId,
    ],
  )

  const minutes = env.otpTtlMinutes
  await sendEmail({
    to: email,
    subject: purpose === "EMAIL_VERIFY" ? "Your ChatMate360 verification code" : "Your ChatMate360 security code",
    text: `Your verification code is: ${code}\n\nIt expires in ${minutes} minutes. If you didn't request this, you can ignore this email.`,
    html: `<p>Your verification code is:</p><p style="font-size:1.5rem;letter-spacing:0.2em;font-weight:700">${code}</p><p>It expires in ${minutes} minutes. If you didn't request this, you can ignore this email.</p>`,
  })

  if (userId && purpose === "EMAIL_VERIFY") {
    await createNotification({
      userId,
      type: "email_verification",
      title: "Verification code sent",
      body: `Enter the 6-digit code from your email. It expires in ${minutes} minutes.`,
    })
  }

  return { ok: true, message: SEND_OK_MESSAGE }
}

export async function verifyOtp(input: VerifyOtpInput): Promise<{
  ok: true
  purpose: OtpPurpose
  proofToken: string
  emailVerified?: boolean
  customerId?: string
  customerToken?: string
  verificationLevel?: string
}> {
  const db = requireDbPool()
  const email = normalizeEmail(input.email)
  const purpose = input.purpose
  const code = input.code.trim()
  const chatbotId = input.chatbotId?.trim() || null
  setTenantContext({
    scope: "auth",
    userEmail: email,
    chatbotId: chatbotId || undefined,
  })
  const customerIdHint = input.customerId?.trim() || null

  if (!/^\d{6}$/.test(code)) {
    throw new AppError(400, "Enter the 6-digit code from your email.")
  }

  if ((purpose === "ORDER_ACCESS" || purpose === "SENSITIVE_ACTION") && !chatbotId) {
    throw new AppError(400, "chatbotId is required for this verification purpose.")
  }

  const { rows } = await db.query<{
    id: string
    otp_hash: string
    expires_at: Date
    attempts: number
    max_attempts: number
    verified_at: Date | null
    user_id: string | null
    chatbot_id: string | null
    customer_id: string | null
  }>(
    `select id, otp_hash, expires_at, attempts, max_attempts, verified_at, user_id, chatbot_id, customer_id
     from auth_otps
     where email = $1 and purpose = $2 and verified_at is null
       and ($3::uuid is null or chatbot_id is not distinct from $3)
       and ($4::uuid is null or customer_id is not distinct from $4)
     order by created_at desc
     limit 1`,
    [email, purpose, chatbotId, customerIdHint],
  )

  const row = rows[0]
  if (!row || row.expires_at.getTime() < Date.now()) {
    throw new AppError(400, "That code is invalid or has expired. Request a new one.")
  }

  // CS-04 / B07-001: reserve the attempt atomically BEFORE comparing, so
  // concurrent guesses can never evaluate more than max_attempts codes.
  const reserved = await db.query<{ attempts: number; max_attempts: number }>(
    `update auth_otps set attempts = attempts + 1
     where id = $1 and verified_at is null and attempts < max_attempts and expires_at > now()
     returning attempts, max_attempts`,
    [row.id],
  )
  if (reserved.rowCount !== 1) {
    throw new AppError(400, "Too many incorrect attempts. Request a new code.")
  }

  if (hashToken(code) !== row.otp_hash) {
    const left = reserved.rows[0].max_attempts - reserved.rows[0].attempts
    throw new AppError(
      400,
      left > 0
        ? `Incorrect code. ${left} attempt${left === 1 ? "" : "s"} remaining.`
        : "Too many incorrect attempts. Request a new code.",
    )
  }

  // Single-use: exactly one caller may consume the code.
  const consumed = await db.query("update auth_otps set verified_at = now() where id = $1 and verified_at is null", [row.id])
  if (consumed.rowCount !== 1) {
    throw new AppError(400, "That code is invalid or has expired. Request a new one.")
  }

  let emailVerified: boolean | undefined
  let customerId = row.customer_id || undefined
  let verificationLevel: string | undefined

  // The identity is created only now, after the code proved the email.
  if ((purpose === "ORDER_ACCESS" || purpose === "SENSITIVE_ACTION") && !customerId && row.chatbot_id) {
    customerId = (await resolveCustomerIdentity(row.chatbot_id, email)).id
  }

  if (purpose === "EMAIL_VERIFY" && row.user_id) {
    await db.query("update users set email_verified = true where id = $1", [row.user_id])
    await db.query("delete from email_verification_tokens where user_id = $1", [row.user_id])
    await createNotification({
      userId: row.user_id,
      type: "system",
      title: "Email verified",
      body: "Your email is verified. You can create chatbots and use the full dashboard.",
    })
    emailVerified = true
  }

  if ((purpose === "ORDER_ACCESS" || purpose === "SENSITIVE_ACTION") && customerId) {
    // Express/Postgres alone promotes verification — never the LLM.
    const level = "EMAIL_VERIFIED"
    await promoteVerificationLevel(customerId, level)
    verificationLevel = level
  }

  const proofToken = signOtpProofToken({
    purpose,
    email,
    userId: row.user_id || undefined,
    chatbotId: row.chatbot_id || undefined,
    customerId,
  })

  // The widget presents this on /public/.../chat to unlock cross-session
  // memory; customerId alone is no longer accepted as proof of identity.
  const customerToken =
    customerId && row.chatbot_id ? signCustomerSessionToken({ customerId, chatbotId: row.chatbot_id }) : undefined

  return {
    ok: true,
    purpose,
    proofToken,
    emailVerified,
    customerId,
    customerToken,
    verificationLevel,
  }
}
