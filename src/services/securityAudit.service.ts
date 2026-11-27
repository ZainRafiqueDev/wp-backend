import { pool } from "../lib/db.js"
import { log } from "../lib/logger.js"
import { runWithSystemContext } from "../lib/tenantContext.js"

export type SecurityAuditEventType =
  | "unauthorized_access"
  | "rls_violation"
  | "admin_action"
  | "webhook_signature_failed"

export type SecurityAuditInput = {
  eventType: SecurityAuditEventType
  userId?: string | null
  chatbotId?: string | null
  ipAddress?: string | null
  userAgent?: string | null
  requestPath?: string | null
  details?: Record<string, unknown>
}

/**
 * Fire-and-forget. Never throws, never logs PII or request bodies.
 * Writes under system context so RLS on this privileged table cannot
 * swallow an audit row from a tenant-scoped request.
 */
export async function recordSecurityEvent(input: SecurityAuditInput): Promise<void> {
  if (!pool) return
  try {
    await runWithSystemContext(async () => {
      await pool!.query(
        `insert into security_audit_log
           (event_type, user_id, chatbot_id, ip_address, user_agent, request_path, details)
         values ($1, $2, $3, $4::inet, $5, $6, $7::jsonb)`,
        [
          input.eventType,
          input.userId ?? null,
          input.chatbotId ?? null,
          sanitizeIp(input.ipAddress),
          truncate(input.userAgent, 400),
          truncate(input.requestPath, 300),
          JSON.stringify(input.details ?? {}),
        ],
      )
    })
  } catch (err) {
    log().warn(
      { event: "security_audit.write_failed", err: err instanceof Error ? err.message : String(err) },
      "failed to write security audit row",
    )
  }
}

function sanitizeIp(value: string | null | undefined): string | null {
  if (!value) return null
  const trimmed = value.trim().split(",")[0]?.trim() ?? ""
  if (!trimmed) return null
  // inet rejected garbage would abort the insert; drop rather than fail closed.
  if (!/^[\d.:a-fA-F]+$/.test(trimmed)) return null
  return truncate(trimmed, 64)
}

function truncate(value: string | null | undefined, max: number): string | null {
  if (!value) return null
  return value.length <= max ? value : value.slice(0, max)
}
