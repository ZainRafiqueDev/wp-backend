
import { pool } from "../lib/db.js"
import { AppError } from "../lib/errors.js"

function requireDbPool() {
  if (!pool) throw new AppError(503, "Database is not configured. Set DATABASE_URL and JWT_SECRET.")
  return pool
}

export interface RecordAdminActionInput {
  chatbotId: string
  adminId: string
  adminEmail: string
  conversationId: string
  requestId?: string
  action: string
  targetResource?: string | null
  beforeState?: unknown
  afterState?: unknown
  success: boolean
  errorMessage?: string | null
}

export async function recordAdminAction(input: RecordAdminActionInput): Promise<void> {
  const db = requireDbPool()
  await db.query(
    `insert into chatbot_bookly_admin_audit_log
       (chatbot_id, admin_id, admin_email, conversation_id, request_id, action, target_resource, before_state, after_state, success, error_message)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      input.chatbotId,
      input.adminId,
      input.adminEmail,
      input.conversationId,
      input.requestId ?? null,
      input.action,
      input.targetResource ?? null,
      input.beforeState !== undefined ? JSON.stringify(input.beforeState) : null,
      input.afterState !== undefined ? JSON.stringify(input.afterState) : null,
      input.success,
      input.errorMessage ?? null,
    ],
  )
}

export interface AdminAuditLogRow {
  id: string
  chatbotId: string
  adminId: string
  adminEmail: string
  conversationId: string
  requestId: string | null
  action: string
  targetResource: string | null
  beforeState: unknown
  afterState: unknown
  success: boolean
  errorMessage: string | null
  createdAt: string
}

function mapRow(row: Record<string, unknown>): AdminAuditLogRow {
  return {
    id: row.id as string,
    chatbotId: row.chatbot_id as string,
    adminId: row.admin_id as string,
    adminEmail: row.admin_email as string,
    conversationId: row.conversation_id as string,
    requestId: (row.request_id as string | null) ?? null,
    action: row.action as string,
    targetResource: (row.target_resource as string | null) ?? null,
    beforeState: row.before_state ?? null,
    afterState: row.after_state ?? null,
    success: row.success as boolean,
    errorMessage: (row.error_message as string | null) ?? null,
    createdAt: (row.created_at as Date).toISOString(),
  }
}


export async function listAdminAuditLogForChatbot(chatbotId: string, limit = 100): Promise<AdminAuditLogRow[]> {
  const db = requireDbPool()
  const { rows } = await db.query(
    `select * from chatbot_bookly_admin_audit_log where chatbot_id = $1 order by created_at desc limit $2`,
    [chatbotId, limit],
  )
  return rows.map(mapRow)
}
