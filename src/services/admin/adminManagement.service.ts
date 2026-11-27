import type { PoolClient } from "pg"

import { hashPassword, revokeAllAdminSessions } from "../../lib/auth.js"
import { AppError } from "../../lib/errors.js"
import { runWithSystemContext } from "../../lib/tenantContext.js"
import type { CreateAdminInput, UpdateAdminInput } from "../../validators/admin.validator.js"
import type { AdminRole } from "./adminAuth.service.js"
import { logAdminAction, requireDbPool } from "./shared.js"

// SA-01: super-admin-only admin management. Every route that reaches this
// module is behind requireAdminAuth + requireSuperAdmin; the actor id passed
// in is req.adminUserId (already checked active and super_admin for this
// request). Writes re-check the actor under a row lock, because a concurrent
// request may have demoted or deactivated them since.
//
// admin_users is reachable only on the system login (CS-15), so every query
// runs inside runWithSystemContext. The audit log keeps target admin ids in
// `detail` (admin_audit_log.target_user_id references customer users).

export const ADMIN_PAGE_DEFAULT_LIMIT = 50
export const ADMIN_PAGE_MAX_LIMIT = 100

export function boundedPage(limit?: number, offset?: number): { limit: number; offset: number } {
  const safeLimit = Math.min(ADMIN_PAGE_MAX_LIMIT, Math.max(1, Math.floor(Number(limit)) || ADMIN_PAGE_DEFAULT_LIMIT))
  const safeOffset = Math.min(1_000_000, Math.max(0, Math.floor(Number(offset)) || 0))
  return { limit: safeLimit, offset: safeOffset }
}

export interface AdminAccountListItem {
  id: string
  email: string
  name: string
  role: AdminRole
  isActive: boolean
  createdAt: string
}

type AdminRow = { id: string; email: string; name: string; role: string; is_active: boolean; created_at: Date }

function toItem(row: AdminRow): AdminAccountListItem {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role === "super_admin" ? "super_admin" : "admin",
    isActive: row.is_active,
    createdAt: row.created_at.toISOString(),
  }
}

async function inTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const db = requireDbPool()
  return runWithSystemContext(async () => {
    const client = await db.connect()
    try {
      await client.query("begin")
      const result = await fn(client)
      await client.query("commit")
      return result
    } catch (err) {
      await client.query("rollback").catch(() => undefined)
      throw err
    } finally {
      client.release()
    }
  })
}

/**
 * Locks every active super admin row (in id order, so two concurrent callers
 * cannot deadlock) and returns their ids. Every change that can reduce the
 * number of active super admins takes this lock first, so two of them can
 * never both pass the "one would remain" check.
 */
async function lockActiveSuperAdmins(client: PoolClient): Promise<string[]> {
  const { rows } = await client.query<{ id: string }>(
    "select id from admin_users where role = 'super_admin' and is_active order by id for update",
  )
  return rows.map((r) => r.id)
}

function assertActorStillSuperAdmin(activeSuperAdminIds: string[], actorId: string): void {
  if (!activeSuperAdminIds.includes(actorId)) throw new AppError(403, "Super admin access required.")
}

export async function listAdminAccounts(
  actorId: string,
  limit?: number,
  offset?: number,
): Promise<{ admins: AdminAccountListItem[]; totalCount: number }> {
  const db = requireDbPool()
  const page = boundedPage(limit, offset)
  const { rows, total } = await runWithSystemContext(async () => {
    const count = await db.query<{ total: number }>("select count(*)::int as total from admin_users")
    const list = await db.query<AdminRow>(
      `select id, email, name, role, is_active, created_at
         from admin_users
        order by (role = 'super_admin') desc, created_at asc, id asc
        limit $1 offset $2`,
      [page.limit, page.offset],
    )
    return { rows: list.rows, total: count.rows[0]?.total ?? 0 }
  })
  await logAdminAction(actorId, "list_admins", null, page)
  return { admins: rows.map(toItem), totalCount: total }
}

export async function createAdminAccount(actorId: string, input: CreateAdminInput): Promise<AdminAccountListItem> {
  const email = input.email.trim().toLowerCase()
  const passwordHash = await hashPassword(input.password)
  const created = await inTransaction(async (client) => {
    assertActorStillSuperAdmin(await lockActiveSuperAdmins(client), actorId)
    const { rows: taken } = await client.query("select 1 from admin_users where lower(email) = $1 limit 1", [email])
    if (taken[0]) throw new AppError(409, "An admin with that email already exists.")
    try {
      const { rows } = await client.query<AdminRow>(
        `insert into admin_users (email, password_hash, name, role, is_active)
         values ($1, $2, $3, $4, true)
         returning id, email, name, role, is_active, created_at`,
        [email, passwordHash, input.name.trim(), input.role],
      )
      return rows[0]
    } catch (err) {
      if (err && typeof err === "object" && (err as { code?: string }).code === "23505") {
        throw new AppError(409, "An admin with that email already exists.")
      }
      throw err
    }
  })
  await logAdminAction(actorId, "create_admin", null, { targetAdminId: created.id, role: created.role })
  return toItem(created)
}

export async function updateAdminAccountByActor(
  actorId: string,
  targetAdminId: string,
  input: UpdateAdminInput,
): Promise<AdminAccountListItem> {
  if (targetAdminId === actorId && input.role !== undefined && input.role !== "super_admin") {
    throw new AppError(400, "You cannot change your own role.")
  }
  if (targetAdminId === actorId && input.isActive === false) {
    throw new AppError(400, "You cannot deactivate your own account.")
  }

  const { before, after } = await inTransaction(async (client) => {
    const activeSuperAdmins = await lockActiveSuperAdmins(client)
    assertActorStillSuperAdmin(activeSuperAdmins, actorId)

    const { rows } = await client.query<AdminRow>(
      "select id, email, name, role, is_active, created_at from admin_users where id = $1 for update",
      [targetAdminId],
    )
    const current = rows[0]
    if (!current) throw new AppError(404, "Admin account not found.")

    const nextRole = input.role ?? current.role
    const nextActive = input.isActive ?? current.is_active
    const nextName = input.name?.trim() ?? current.name

    const losesSuperAdmin =
      current.role === "super_admin" && current.is_active && (nextRole !== "super_admin" || !nextActive)
    if (losesSuperAdmin && activeSuperAdmins.filter((id) => id !== targetAdminId).length === 0) {
      throw new AppError(409, "At least one active super admin must remain.")
    }

    const { rows: updated } = await client.query<AdminRow>(
      `update admin_users set role = $1, is_active = $2, name = $3 where id = $4
       returning id, email, name, role, is_active, created_at`,
      [nextRole, nextActive, nextName, targetAdminId],
    )
    // Deactivation ends every existing session of that admin (requireAdminAuth
    // also refuses inactive admins outright; the watermark keeps a later
    // reactivation from bringing the old cookies back).
    if (current.is_active && !nextActive) await revokeAllAdminSessions(client, targetAdminId)
    return { before: current, after: updated[0] }
  })

  await logAdminAction(actorId, "update_admin", null, {
    targetAdminId,
    role: before.role !== after.role ? { from: before.role, to: after.role } : undefined,
    isActive: before.is_active !== after.is_active ? { from: before.is_active, to: after.is_active } : undefined,
    nameChanged: before.name !== after.name,
  })
  return toItem(after)
}

export async function revokeAdminSessionsByActor(actorId: string, targetAdminId: string): Promise<void> {
  if (targetAdminId === actorId) {
    throw new AppError(400, "Use sign out to end your own sessions.")
  }
  await inTransaction(async (client) => {
    assertActorStillSuperAdmin(await lockActiveSuperAdmins(client), actorId)
    const { rows } = await client.query("select 1 from admin_users where id = $1 for update", [targetAdminId])
    if (!rows[0]) throw new AppError(404, "Admin account not found.")
    await revokeAllAdminSessions(client, targetAdminId)
  })
  await logAdminAction(actorId, "revoke_admin_sessions", null, { targetAdminId })
}
