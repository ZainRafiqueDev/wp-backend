import { createHash, randomBytes } from "node:crypto"

import { pool } from "../lib/db.js"
import { sendEmail } from "../lib/email.js"
import { env } from "../env.js"
import { log } from "../lib/logger.js"
import { setTenantContext } from "../lib/tenantContext.js"

export type NotificationType =
  | "usage_limit"
  | "payment"
  | "subscription"
  | "handoff"
  | "auto_purchase"
  | "system"
  | "email_verification"

export type Notification = {
  id: string
  type: NotificationType
  title: string
  body: string
  metadata: Record<string, unknown>
  readAt: string | null
  createdAt: string
}

function requirePool() {
  if (!pool) throw new Error("Database is not configured.")
  return pool
}

export async function createNotification(input: {
  userId: string
  type: NotificationType
  title: string
  body: string
  metadata?: Record<string, unknown>
  emailTo?: string
}): Promise<Notification | null> {
  if (!pool) return null
  setTenantContext({ userId: input.userId })
  const { rows } = await pool.query<{
    id: string
    type: string
    title: string
    body: string
    metadata: Record<string, unknown>
    read_at: Date | null
    created_at: Date
  }>(
    `insert into notifications (user_id, type, title, body, metadata)
     values ($1, $2, $3, $4, $5::jsonb)
     returning id, type, title, body, metadata, read_at, created_at`,
    [input.userId, input.type, input.title, input.body, JSON.stringify(input.metadata || {})],
  )
  const row = rows[0]
  if (!row) return null

  if (input.emailTo) {
    void sendEmail({
      to: input.emailTo,
      subject: input.title,
      text: input.body,
    }).catch((err) => log().warn({ err: err instanceof Error ? err.message : String(err) }, "notification email failed"))
  }

  return {
    id: row.id,
    type: row.type as NotificationType,
    title: row.title,
    body: row.body,
    metadata: row.metadata || {},
    readAt: row.read_at ? row.read_at.toISOString() : null,
    createdAt: row.created_at.toISOString(),
  }
}

export async function listNotificationsForUser(userId: string, limit = 50): Promise<Notification[]> {
  const db = requirePool()
  setTenantContext({ userId })
  const { rows } = await db.query<{
    id: string
    type: string
    title: string
    body: string
    metadata: Record<string, unknown>
    read_at: Date | null
    created_at: Date
  }>(
    `select id, type, title, body, metadata, read_at, created_at
     from notifications where user_id = $1
     order by created_at desc limit $2`,
    [userId, limit],
  )
  return rows.map((row) => ({
    id: row.id,
    type: row.type as NotificationType,
    title: row.title,
    body: row.body,
    metadata: row.metadata || {},
    readAt: row.read_at ? row.read_at.toISOString() : null,
    createdAt: row.created_at.toISOString(),
  }))
}

export async function markNotificationRead(userId: string, notificationId: string): Promise<boolean> {
  const db = requirePool()
  setTenantContext({ userId })
  const { rowCount } = await db.query(
    `update notifications set read_at = now()
     where id = $1 and user_id = $2 and read_at is null`,
    [notificationId, userId],
  )
  return Boolean(rowCount)
}

export async function markAllNotificationsRead(userId: string): Promise<number> {
  const db = requirePool()
  setTenantContext({ userId })
  const { rowCount } = await db.query(
    `update notifications set read_at = now() where user_id = $1 and read_at is null`,
    [userId],
  )
  return rowCount || 0
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex")
}

export function generateOpaqueToken(): string {
  return randomBytes(32).toString("hex")
}

export async function issueEmailVerification(userId: string, email: string): Promise<void> {
  if (!pool) return
  setTenantContext({ userId })
  const token = generateOpaqueToken()
  const expires = new Date(Date.now() + 1000 * 60 * 60 * 24)
  await pool.query("delete from email_verification_tokens where user_id = $1", [userId])
  await pool.query(
    `insert into email_verification_tokens (user_id, token_hash, expires_at) values ($1, $2, $3)`,
    [userId, hashToken(token), expires],
  )
  const link = `${env.frontendUrl.replace(/\/$/, "")}/auth/verify?token=${token}`
  await sendEmail({
    to: email,
    subject: "Verify your ChatMate360 email",
    text: `Verify your email to activate your account:\n\n${link}\n\nThis link expires in 24 hours.`,
    html: `<p>Verify your email to activate your account.</p><p><a href="${link}">Verify email</a></p><p>This link expires in 24 hours.</p>`,
  })
  await createNotification({
    userId,
    type: "email_verification",
    title: "Verify your email",
    body: "Check your inbox for a verification link. Until then, creating new chatbots is blocked.",
    metadata: {},
  })
}
