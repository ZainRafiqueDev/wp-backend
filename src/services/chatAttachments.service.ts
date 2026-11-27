import { randomUUID } from "node:crypto"

import { verifyAccessToken } from "../lib/auth.js"
import { pool } from "../lib/db.js"
import { AppError } from "../lib/errors.js"
import { CONTENT_TYPE_FOR_SNIFFED_TYPE, sniffAttachmentType, type SniffedAttachmentType } from "../lib/fileTypeSniff.js"
import { attachmentStorageKey, deleteDocumentObject, getDocumentObject, putDocumentObject } from "../lib/objectStorage.js"
import { requireOwnedChatbotId } from "../lib/chatbotOwnership.js"
import { resolveTenantContext } from "../lib/tenancy.js"
import { env } from "../env.js"
import { getEntitlementForChatbot } from "./billing.service.js"
import { chatSessionKey, verifyWidgetSessionToken } from "./customerSession.service.js"
import { verifiedCustomerFromSessionToken } from "./customerVerification.service.js"
import { verifiedCustomerForChatSession } from "../langgraph/sessionIdentity.js"
import { loadConversationContext, recordTurn } from "./conversation.service.js"
import { MALWARE_DENIED_MESSAGE, MalwareScanUnavailableError, scanDocumentBytes } from "./malwareScan.service.js"
import { authorizePublicRequest } from "./public.service.js"

export const ATTACHMENT_ACK_MESSAGE = "Thanks, your file was received and the team will review it."

function requireDbPool() {
  if (!pool) throw new AppError(503, "Database is not configured. Set DATABASE_URL and JWT_SECRET.")
  return pool
}

function requireUserId(accessToken: string): string {
  const userId = verifyAccessToken(accessToken)
  if (!userId) throw new AppError(401, "Please sign in again.")
  return userId
}

export interface ChatAttachment {
  id: string
  chatbotId: string
  conversationId: string
  customerIdentityId: string | null
  booklyAppointmentId: string | null
  originalFileName: string
  contentType: string
  fileSize: number
  status: "quarantined" | "clean" | "denied"
  createdAt: string
  expiresAt: string
  // Only populated on the dashboard list, from a left join — null for an
  // anonymous visitor who never resolved to a known identity.
  visitorEmail?: string | null
}

function mapAttachmentRow(row: {
  id: string
  chatbot_id: string
  conversation_id: string
  customer_identity_id: string | null
  bookly_appointment_id: string | null
  original_file_name: string
  content_type: string
  file_size: string | number
  status: string
  created_at: Date
  expires_at: Date
  visitor_email?: string | null
}): ChatAttachment {
  return {
    id: row.id,
    chatbotId: row.chatbot_id,
    conversationId: row.conversation_id,
    customerIdentityId: row.customer_identity_id,
    booklyAppointmentId: row.bookly_appointment_id,
    originalFileName: row.original_file_name,
    contentType: row.content_type,
    fileSize: Number(row.file_size),
    status: row.status as ChatAttachment["status"],
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    visitorEmail: row.visitor_email ?? null,
  }
}

const ATTACHMENT_COLUMNS =
  "id, chatbot_id, conversation_id, customer_identity_id, bookly_appointment_id, original_file_name, content_type, file_size, status, created_at, expires_at"

async function getChatbotOwnerUserId(chatbotId: string): Promise<string> {
  const { rows } = await requireDbPool().query<{ user_id: string }>("select user_id from chatbots where id = $1", [chatbotId])
  if (!rows[0]) throw new AppError(404, "Chatbot not found.")
  return rows[0].user_id
}

// One atomic conditional UPDATE — concurrent uploads racing the same
// account's pool are serialized by Postgres's own row lock on UPDATE, and
// each call here is its own single-statement transaction (db.ts wraps a
// bare pool.query() in its own BEGIN/COMMIT), so there's no window for two
// uploads to both succeed past the cap. The row is created lazily so the
// first attachment ever uploaded for an account doesn't need a migration
// backfill or a signup-time hook.
async function reserveAttachmentStorage(ownerUserId: string, bytes: number, limitBytes: number): Promise<void> {
  const db = requireDbPool()
  await db.query(
    `insert into attachment_storage_usage (owner_user_id, bytes_used) values ($1, 0) on conflict (owner_user_id) do nothing`,
    [ownerUserId],
  )
  const { rows } = await db.query(
    `update attachment_storage_usage set bytes_used = bytes_used + $2, updated_at = now()
     where owner_user_id = $1 and bytes_used + $2 <= $3
     returning bytes_used`,
    [ownerUserId, bytes, limitBytes],
  )
  if (!rows[0]) {
    const { rows: currentRows } = await db.query<{ bytes_used: string }>(
      `select bytes_used from attachment_storage_usage where owner_user_id = $1`,
      [ownerUserId],
    )
    const used = Number(currentRows[0]?.bytes_used ?? 0)
    throw new AppError(
      409,
      `This account has reached its ${Math.floor(limitBytes / (1024 * 1024))}MB attachment storage limit.`,
      { code: "ATTACHMENT_STORAGE_LIMIT_REACHED", data: { used, limit: limitBytes } },
    )
  }
}

async function releaseAttachmentStorage(ownerUserId: string, bytes: number): Promise<void> {
  await requireDbPool().query(
    `update attachment_storage_usage set bytes_used = greatest(0, bytes_used - $2), updated_at = now() where owner_user_id = $1`,
    [ownerUserId, bytes],
  )
}

export interface UploadAttachmentInput {
  chatbotId: string
  widgetOrigin: string | undefined
  refererHeader: string | undefined
  requesterIp: string
  /** CS-04: the server-issued widget session token (never a client-chosen id). */
  sessionToken?: string
  /** Optional signed customer token from /auth/otp/verify. */
  customerToken?: string
  /** Legacy: must match the verified customer if sent; never trusted on its own. */
  customerId?: string
  bookingId?: string
  file: { originalname: string; size: number; buffer: Buffer }
}

export async function uploadAttachment(input: UploadAttachmentInput): Promise<ChatAttachment> {
  const db = requireDbPool()
  // Second line of defence behind uploadAttachmentMiddleware's same check.
  if (env.documentScanPauseUploads) {
    throw new AppError(503, "File attachments are turned off for now.")
  }
  const chatbot = await authorizePublicRequest(input.chatbotId, input.widgetOrigin, input.refererHeader, input.requesterIp)

  const entitlement = await getEntitlementForChatbot(chatbot.id)
  const caps = entitlement.chatAttachments
  if (!caps.enabled) {
    throw new AppError(402, "File attachments require the Crawl Plus plan or higher.")
  }

  if (input.file.size > caps.maxFileSizeBytes) {
    throw new AppError(413, `File is too large — max ${Math.floor(caps.maxFileSizeBytes / (1024 * 1024))}MB.`, {
      code: "FILE_TOO_LARGE",
      data: { limit: caps.maxFileSizeBytes },
    })
  }

  const sniffed: SniffedAttachmentType | null = sniffAttachmentType(input.file.buffer)
  if (!sniffed || !caps.allowedTypes.includes(sniffed)) {
    throw new AppError(400, "Unsupported file type. Allowed: PNG, JPG, WEBP, PDF, TXT.", { code: "UNSUPPORTED_FILE_TYPE" })
  }

  // CS-04: the conversation comes from the server-issued session only.
  const sid = verifyWidgetSessionToken(input.sessionToken, chatbot.id)
  if (!sid) {
    throw new AppError(400, "Send a chat message before attaching a file.", { code: "SESSION_REQUIRED" })
  }
  const sessionKey = chatSessionKey("widget", sid)
  const { conversationId } = await loadConversationContext(chatbot.id, sessionKey)

  const { rows: countRows } = await db.query<{ n: string }>(
    `select count(*)::text as n from chatbot_attachments where conversation_id = $1 and status <> 'denied'`,
    [conversationId],
  )
  if (Number(countRows[0].n) >= env.attachmentMaxPerConversation) {
    throw new AppError(409, "This conversation has reached its attachment limit.", { code: "ATTACHMENT_CONVERSATION_LIMIT_REACHED" })
  }

  // CS-04: the customer is whoever this session (or a signed customer token)
  // has PROVED it is — never a customerId/bookingId taken from the request.
  const fromToken = await verifiedCustomerFromSessionToken(chatbot.id, input.customerToken)
  const verifiedCustomerId = fromToken?.customerId ?? (await verifiedCustomerForChatSession(chatbot.id, sessionKey))
  if (input.customerId && input.customerId !== verifiedCustomerId) {
    throw new AppError(400, "Invalid customer.")
  }
  const customerIdentityId: string | null = verifiedCustomerId

  let booklyAppointmentId: string | null = null
  if (input.bookingId) {
    if (!verifiedCustomerId) throw new AppError(400, "Invalid booking.")
    const { rows } = await db.query(`select id from chatbot_bookly_appointments where id = $1 and chatbot_id = $2 and customer_id = $3`, [
      input.bookingId,
      chatbot.id,
      verifiedCustomerId,
    ])
    if (!rows[0]) throw new AppError(400, "Invalid booking.")
    booklyAppointmentId = input.bookingId
  }

  const ownerUserId = await getChatbotOwnerUserId(chatbot.id)
  await reserveAttachmentStorage(ownerUserId, input.file.size, caps.totalStorageBytes)

  const attachmentId = randomUUID()
  const generatedFileName = `${randomUUID()}.${sniffed}`
  const storageKey = attachmentStorageKey(chatbot.id, attachmentId, generatedFileName)
  const contentType = CONTENT_TYPE_FOR_SNIFFED_TYPE[sniffed]
  const expiresAt = new Date(Date.now() + caps.retentionDays * 24 * 60 * 60 * 1000)

  let rolledBack = false
  const rollback = async () => {
    if (rolledBack) return
    rolledBack = true
    await deleteDocumentObject(storageKey)
    await releaseAttachmentStorage(ownerUserId, input.file.size)
  }

  try {
    await putDocumentObject(storageKey, input.file.buffer)
    await db.query(
      `insert into chatbot_attachments
         (id, chatbot_id, conversation_id, customer_identity_id, bookly_appointment_id,
          storage_key, generated_file_name, original_file_name, content_type, file_size, status, expires_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'quarantined', $11)`,
      [
        attachmentId,
        chatbot.id,
        conversationId,
        customerIdentityId,
        booklyAppointmentId,
        storageKey,
        generatedFileName,
        input.file.originalname.slice(0, 255),
        contentType,
        input.file.size,
        expiresAt,
      ],
    )
  } catch (err) {
    await rollback()
    throw err
  }

  let scan: Awaited<ReturnType<typeof scanDocumentBytes>>
  try {
    scan = await scanDocumentBytes(input.file.buffer)
  } catch (err) {
    // Fail-closed: a scan that couldn't run is treated exactly like a scan
    // that found something — the attachment never exists in a servable
    // state. No row is left behind for the uploader to retry against; they
    // just upload again.
    await db.query(`delete from chatbot_attachments where id = $1`, [attachmentId])
    await rollback()
    if (err instanceof MalwareScanUnavailableError) throw err
    throw new MalwareScanUnavailableError("The malware scan is temporarily unavailable. Please try again shortly.")
  }

  if (scan.status !== "clean") {
    await db.query(`delete from chatbot_attachments where id = $1`, [attachmentId])
    await rollback()
    throw new AppError(409, MALWARE_DENIED_MESSAGE, { code: "ATTACHMENT_DENIED" })
  }

  const { rows: updatedRows } = await db.query(
    `update chatbot_attachments set status = 'clean' where id = $1 returning ${ATTACHMENT_COLUMNS}`,
    [attachmentId],
  )

  // Fixed acknowledgement only — the bot must never claim to have read the
  // file's contents in v1 (no auto-add to the knowledge base, no extraction).
  await recordTurn(conversationId, `[Uploaded a file: ${input.file.originalname.slice(0, 255)}]`, ATTACHMENT_ACK_MESSAGE)

  return mapAttachmentRow(updatedRows[0])
}

export async function listAttachments(accessToken: string, chatbotId: string): Promise<ChatAttachment[]> {
  const db = requireDbPool()
  const actorUserId = requireUserId(accessToken)
  const { tenantUserId } = await resolveTenantContext(actorUserId, "viewer")
  const ownedId = await requireOwnedChatbotId(tenantUserId, chatbotId)

  const { rows } = await db.query(
    `select a.${ATTACHMENT_COLUMNS.split(", ").join(", a.")}, ci.email as visitor_email
     from chatbot_attachments a
     left join customer_identities ci on ci.id = a.customer_identity_id
     where a.chatbot_id = $1 and a.status = 'clean'
     order by a.created_at desc`,
    [ownedId],
  )
  return rows.map(mapAttachmentRow)
}

export interface AttachmentDownload {
  attachment: ChatAttachment
  buffer: Buffer
}

export async function getAttachmentForDownload(accessToken: string, chatbotId: string, attachmentId: string): Promise<AttachmentDownload> {
  const db = requireDbPool()
  const actorUserId = requireUserId(accessToken)
  const { tenantUserId } = await resolveTenantContext(actorUserId, "viewer")
  const ownedId = await requireOwnedChatbotId(tenantUserId, chatbotId)

  const { rows } = await db.query(
    `select ${ATTACHMENT_COLUMNS}, storage_key from chatbot_attachments where id = $1 and chatbot_id = $2`,
    [attachmentId, ownedId],
  )
  const row = rows[0]
  if (!row) throw new AppError(404, "Attachment not found.")
  // Defense in depth alongside the upload path's own fail-closed handling —
  // a quarantined or denied attachment is never served, full stop.
  if (row.status !== "clean") throw new AppError(404, "Attachment not found.")

  const buffer = await getDocumentObject(row.storage_key as string)
  return { attachment: mapAttachmentRow(row), buffer }
}

export async function runAttachmentRetentionTick(): Promise<{ deleted: number; recomputed: number }> {
  const db = requireDbPool()

  const { rows: expired } = await db.query<{ id: string; chatbot_id: string; storage_key: string; file_size: string }>(
    `select ca.id, ca.chatbot_id, ca.storage_key, ca.file_size
     from chatbot_attachments ca
     where ca.expires_at < now()`,
  )
  for (const row of expired) {
    const ownerUserId = await getChatbotOwnerUserId(row.chatbot_id).catch(() => null)
    await deleteDocumentObject(row.storage_key)
    await db.query(`delete from chatbot_attachments where id = $1`, [row.id])
    if (ownerUserId) await releaseAttachmentStorage(ownerUserId, Number(row.file_size))
  }

  // Nightly drift correction: recompute bytes_used straight from the
  // source of truth (chatbot_attachments) for every account with a
  // counter row, rather than trusting the incremental reserve/release
  // bookkeeping forever.
  const { rowCount } = await db.query(
    `update attachment_storage_usage u
     set bytes_used = coalesce(totals.total, 0), updated_at = now()
     from (
       select c.user_id as owner_user_id, coalesce(sum(ca.file_size), 0) as total
       from chatbots c
       left join chatbot_attachments ca on ca.chatbot_id = c.id and ca.status = 'clean'
       group by c.user_id
     ) totals
     where totals.owner_user_id = u.owner_user_id`,
  )

  return { deleted: expired.length, recomputed: rowCount ?? 0 }
}
