import {
  hashPassword,
  revokeAllAdminSessions,
  signAdminAccessToken,
  verifyAdminAccessToken,
  verifyPassword,
} from "../../lib/auth.js"
import { AppError } from "../../lib/errors.js"
import { log } from "../../lib/logger.js"
import { runWithSystemContext, setTenantContext } from "../../lib/tenantContext.js"
import type { AdminLoginInput, UpdateAdminAccountInput } from "../../validators/admin.validator.js"
import { logAdminAction, requireDbPool } from "./shared.js"

export function requireAdminUserId(accessToken: string): string {
  const adminUserId = verifyAdminAccessToken(accessToken)
  if (!adminUserId) throw new AppError(401, "Admin sign-in required.")
  return adminUserId
}

export type AdminRole = "super_admin" | "admin"

export interface AdminSelf {
  id: string
  email: string
  name: string
  role: AdminRole
}

function toRole(value: string): AdminRole {
  return value === "super_admin" ? "super_admin" : "admin"
}

export async function adminLogin(input: AdminLoginInput): Promise<{ accessToken: string; admin: AdminSelf }> {
  const db = requireDbPool()
  // CS-15: admin_users (password hashes) is readable only on the system
  // login; the tenant role has no access after the lockdown migration.
  const { rows } = await runWithSystemContext(() =>
    db.query<{ id: string; email: string; name: string; password_hash: string; role: string; is_active: boolean }>(
      "select id, email, name, password_hash, role, is_active from admin_users where email = $1",
      [input.email.trim().toLowerCase()],
    ),
  )
  const row = rows[0]
  if (!row) throw new AppError(401, "Invalid email or password.")

  const valid = await verifyPassword(input.password, row.password_hash)
  if (!valid) throw new AppError(401, "Invalid email or password.")
  // SA-01: a deactivated admin gets the same answer as a wrong password, so
  // the endpoint does not reveal which admin accounts exist but are disabled.
  if (!row.is_active) throw new AppError(401, "Invalid email or password.")

  // CS-11: a credential change or logout can commit while bcrypt runs. Under
  // the admin row lock, re-check that the verified hash is still current and
  // take the token's iat from the database clock (the clock
  // tokens_valid_after uses), so any later revocation is newer than it.
  // CS-15: db.connect() inside the system context checks out from the
  // system pool (chatmate360_system), the only login that can read admin_users.
  const issuedAt = await runWithSystemContext(async () => {
    const client = await db.connect()
    try {
      await client.query("begin")
      const { rows: current } = await client.query<{ password_hash: string; is_active: boolean }>(
        "select password_hash, is_active from admin_users where id = $1 for update",
        [row.id],
      )
      if (!current[0] || current[0].password_hash !== row.password_hash || !current[0].is_active) {
        throw new AppError(401, "Invalid email or password.")
      }
      // Read after the lock is held, so it is later than any revocation that committed first.
      const { rows: clock } = await client.query<{ now: Date }>("select clock_timestamp() as now")
      await client.query("commit")
      return clock[0].now
    } catch (err) {
      await client.query("rollback").catch(() => undefined)
      throw err
    } finally {
      client.release()
    }
  })

  log().info({ adminUserId: row.id }, "admin login")
  return {
    accessToken: signAdminAccessToken(row.id, issuedAt),
    admin: { id: row.id, email: row.email, name: row.name, role: toRole(row.role) },
  }
}

export async function getAdminSelf(accessToken: string): Promise<AdminSelf> {
  const adminUserId = requireAdminUserId(accessToken)
  const db = requireDbPool()
  const { rows } = await runWithSystemContext(() =>
    db.query<{ id: string; email: string; name: string; role: string }>(
      "select id, email, name, role from admin_users where id = $1",
      [adminUserId],
    ),
  )
  if (!rows[0]) throw new AppError(404, "Admin account not found.")
  return { ...rows[0], role: toRole(rows[0].role) }
}

function isUniqueViolation(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && "code" in err && (err as { code?: string }).code === "23505")
}

// Self-service email/password change — requires the admin's OWN current
// password even though they're already authenticated, same reasoning as
// any account-security change: a merely-valid session token shouldn't be
// enough to take over the account if it's left open on a shared machine.
//
// SA-01: the password policy is enforced by updateAdminAccountSchema (12+
// characters). The email is normalised (trimmed, lower-cased) and checked
// case-insensitively against every other admin. The update and the session
// revocation run in one transaction under the admin row lock, after
// re-checking that the verified hash is still current, so a concurrent change
// cannot slip between the password check and the write.
export async function updateAdminAccount(
  accessToken: string,
  input: UpdateAdminAccountInput,
): Promise<{ admin: AdminSelf; accessToken: string | null }> {
  const adminUserId = requireAdminUserId(accessToken)
  const db = requireDbPool()

  const { rows } = await runWithSystemContext(() =>
    db.query<{ email: string; password_hash: string; name: string; role: string }>(
      "select email, password_hash, name, role from admin_users where id = $1",
      [adminUserId],
    ),
  )
  const row = rows[0]
  if (!row) throw new AppError(404, "Admin account not found.")

  const valid = await verifyPassword(input.currentPassword, row.password_hash)
  if (!valid) {
    await logAdminAction(adminUserId, "update_admin_account_failed", null, { reason: "wrong_current_password" })
    throw new AppError(401, "Current password is incorrect.")
  }

  const requestedEmail = input.newEmail?.trim().toLowerCase()
  const nextEmail = requestedEmail || row.email
  const changedEmail = nextEmail !== row.email
  const changedPassword = Boolean(input.newPassword)
  const admin: AdminSelf = { id: adminUserId, email: nextEmail, name: row.name, role: toRole(row.role) }
  if (!changedEmail && !changedPassword) return { admin, accessToken: null }

  const nextPasswordHash = input.newPassword ? await hashPassword(input.newPassword) : row.password_hash

  // CS-11: an email or password change ends every admin session issued so
  // far (one opened with the old credentials may belong to whoever learned
  // them). The caller gets a fresh token for its own cookie and stays signed in.
  const watermark = await runWithSystemContext(async () => {
    const client = await db.connect()
    try {
      await client.query("begin")
      const { rows: current } = await client.query<{ password_hash: string; is_active: boolean }>(
        "select password_hash, is_active from admin_users where id = $1 for update",
        [adminUserId],
      )
      if (!current[0] || !current[0].is_active || current[0].password_hash !== row.password_hash) {
        throw new AppError(409, "Your account changed while this request was running. Sign in again and retry.")
      }
      if (changedEmail) {
        const { rows: taken } = await client.query(
          "select 1 from admin_users where lower(email) = $1 and id <> $2 limit 1",
          [nextEmail, adminUserId],
        )
        if (taken[0]) throw new AppError(409, "That email is already used by another admin account.")
      }
      await client.query("update admin_users set email = $1, password_hash = $2 where id = $3", [
        nextEmail,
        nextPasswordHash,
        adminUserId,
      ])
      const revokedAt = await revokeAllAdminSessions(client, adminUserId)
      await client.query("commit")
      return revokedAt
    } catch (err) {
      await client.query("rollback").catch(() => undefined)
      if (isUniqueViolation(err)) throw new AppError(409, "That email is already used by another admin account.")
      throw err
    } finally {
      client.release()
    }
  })

  // No secrets in the audit row: only which credential changed.
  await logAdminAction(adminUserId, "update_admin_account", null, { changedEmail, changedPassword, otherSessionsRevoked: true })

  return { admin, accessToken: signAdminAccessToken(adminUserId, watermark) }
}

/**
 * CS-11: server-side admin logout. Moves this admin's token watermark to now,
 * so every admin token issued so far (this browser's cookie, a copied token,
 * another device) stops working on its next request. Admin accounts are few
 * and their sessions short, so "sign out everywhere" is the simple, safe
 * choice over tracking individual admin sessions. An invalid or expired token
 * is a no-op; the controller clears the cookie either way.
 */
export async function adminLogout(accessToken: string): Promise<void> {
  const adminUserId = verifyAdminAccessToken(accessToken)
  if (!adminUserId) return
  // No requireAdminAuth on this route (an expired session must still be able
  // to clear its cookie), so set the admin scope it would have set.
  // CS-15: admin scope routes to the system pool, the only login that can
  // write admin_users after the lockdown.
  setTenantContext({ scope: "admin", adminUserId })
  await revokeAllAdminSessions(requireDbPool(), adminUserId)
  await logAdminAction(adminUserId, "admin_logout", null)
}
