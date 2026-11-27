import type { Pool } from "pg"

import { pool } from "../../lib/db.js"
import { AppError } from "../../lib/errors.js"
import { log } from "../../lib/logger.js"

// Private helpers genuinely shared across every admin/* module — kept here
// instead of duplicated per file, but never re-exported from the
// admin.service.ts barrel (nothing outside src/services/admin/ should call
// these directly).

export function requireDbPool(): Pool {
  if (!pool) {
    throw new AppError(503, "Database is not configured. Set DATABASE_URL and JWT_SECRET.")
  }
  return pool
}

export async function logAdminAction(
  adminUserId: string,
  action: string,
  targetUserId: string | null,
  detail: Record<string, unknown> = {},
): Promise<void> {
  const db = requireDbPool()
  await db.query(
    "insert into admin_audit_log (admin_user_id, action, target_user_id, detail) values ($1, $2, $3, $4)",
    [adminUserId, action, targetUserId, JSON.stringify(detail)],
  )
  log().info({ adminUserId, action, targetUserId, detail }, "admin action")
}
