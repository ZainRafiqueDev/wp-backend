import { AppError } from "../../lib/errors.js"
import { requireAdminUserId } from "./adminAuth.service.js"
import { logAdminAction, requireDbPool } from "./shared.js"

export interface AdminAbuseFlagListItem {
  id: string
  chatbotId: string
  chatbotName: string
  reason: string
  detail: Record<string, unknown>
  autoDeactivated: boolean
  reviewed: boolean
  createdAt: string
}

export async function listAbuseFlags(accessToken: string): Promise<AdminAbuseFlagListItem[]> {
  requireAdminUserId(accessToken)
  const db = requireDbPool()

  const { rows } = await db.query<{
    id: string
    chatbot_id: string
    chatbot_name: string
    reason: string
    detail: unknown
    auto_deactivated: boolean
    reviewed: boolean
    created_at: Date
  }>(
    `select f.id, f.chatbot_id, c.name as chatbot_name, f.reason, f.detail, f.auto_deactivated, f.reviewed, f.created_at
     from chatbot_abuse_flags f
     join chatbots c on c.id = f.chatbot_id
     order by f.created_at desc
     limit 200`,
  )

  return rows.map((row) => ({
    id: row.id,
    chatbotId: row.chatbot_id,
    chatbotName: row.chatbot_name,
    reason: row.reason,
    detail: (row.detail as Record<string, unknown>) || {},
    autoDeactivated: row.auto_deactivated,
    reviewed: row.reviewed,
    createdAt: row.created_at.toISOString(),
  }))
}

export async function markAbuseFlagReviewed(accessToken: string, flagId: string): Promise<void> {
  const adminUserId = requireAdminUserId(accessToken)
  const db = requireDbPool()

  const { rowCount } = await db.query("update chatbot_abuse_flags set reviewed = true where id = $1", [flagId])
  if (!rowCount) throw new AppError(404, "Abuse flag not found.")

  await logAdminAction(adminUserId, "review_abuse_flag", null, { flagId })
}
