// SA-01: create or promote the platform super admin. See docs/ADMIN.md.
//
//   SUPER_ADMIN_EMAIL=ops@example.com \
//   SUPER_ADMIN_PASSWORD=... \                  # optional, 12+ characters
//   SUPER_ADMIN_CREDENTIALS_FILE=/secure/path \ # required when no password is given
//   npm run seed-super-admin [-- --reset-password]
//
// - Runs on the system login (SYSTEM_DATABASE_URL): admin_users is not
//   reachable on the tenant login (CS-15).
// - Idempotent. A new email creates an active super_admin. An existing email
//   is promoted to super_admin and re-activated; its password is only changed
//   with --reset-password (which also ends that admin's existing sessions).
// - Without SUPER_ADMIN_PASSWORD a strong random password is generated and
//   written, with the email, ONLY to SUPER_ADMIN_CREDENTIALS_FILE (mode 0600,
//   never overwriting an existing file, never inside this repository). The
//   password is never logged or printed.
import { randomBytes } from "node:crypto"
import { constants as fsConstants } from "node:fs"
import { open, realpath, unlink } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import type { Pool } from "pg"

import { hashPassword, revokeAllAdminSessions } from "../src/lib/auth.js"
import { runWithSystemContext } from "../src/lib/tenantContext.js"
import { adminPasswordProblem } from "../src/validators/admin.validator.js"

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

export class SeedSuperAdminError extends Error {}

export interface SeedSuperAdminOptions {
  email: string | undefined
  password: string | undefined
  credentialsFile: string | undefined
  resetPassword: boolean
  name?: string
  /** Repository root that the credentials file must stay out of (tests override it). */
  repoRoot?: string
}

export interface SeedSuperAdminResult {
  adminUserId: string
  email: string
  action: "created" | "promoted" | "unchanged"
  passwordSet: boolean
  credentialsFileWritten: string | null
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** A 32-character URL-safe password from 24 random bytes (192 bits). */
export function generateStrongPassword(): string {
  return randomBytes(24).toString("base64url")
}

async function resolveThroughExistingParent(target: string): Promise<string> {
  // Resolve symlinks on the deepest existing ancestor, so a link that points
  // back into the repository is caught even though the file does not exist yet.
  let current = path.resolve(target)
  const rest: string[] = []
  for (;;) {
    try {
      const real = await realpath(current)
      return path.join(real, ...rest)
    } catch {
      const parent = path.dirname(current)
      if (parent === current) return path.resolve(target)
      rest.unshift(path.basename(current))
      current = parent
    }
  }
}

function isInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

export async function assertCredentialsPathOutsideRepo(file: string, repoRoot: string): Promise<string> {
  if (!path.isAbsolute(file)) throw new SeedSuperAdminError("SUPER_ADMIN_CREDENTIALS_FILE must be an absolute path.")
  const resolved = await resolveThroughExistingParent(file)
  const realRoot = await resolveThroughExistingParent(repoRoot)
  const norm = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p)
  if (isInside(norm(resolved), norm(realRoot)) || isInside(norm(path.resolve(file)), norm(path.resolve(repoRoot)))) {
    throw new SeedSuperAdminError("Refusing to write credentials inside the repository. Choose a path outside it.")
  }
  return resolved
}

async function writeCredentialsFile(file: string, email: string, password: string): Promise<void> {
  // O_EXCL: never overwrite (or follow a planted symlink at) an existing file.
  const handle = await open(file, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600)
  try {
    await handle.writeFile(`SUPER_ADMIN_EMAIL=${email}\nSUPER_ADMIN_PASSWORD=${password}\n`, "utf8")
  } finally {
    await handle.close()
  }
}

export async function seedSuperAdmin(db: Pool, options: SeedSuperAdminOptions): Promise<SeedSuperAdminResult> {
  const email = options.email?.trim().toLowerCase() ?? ""
  if (!EMAIL_RE.test(email) || email.length > 320) {
    throw new SeedSuperAdminError("SUPER_ADMIN_EMAIL must be a valid email address.")
  }
  const repoRoot = options.repoRoot ?? REPO_ROOT

  if (options.password !== undefined && options.password !== "") {
    const problem = adminPasswordProblem(options.password)
    if (problem) throw new SeedSuperAdminError(`SUPER_ADMIN_PASSWORD rejected: ${problem}`)
  }
  const passwordGiven = Boolean(options.password)

  const existing = await runWithSystemContext(() =>
    db.query<{ id: string; role: string; is_active: boolean }>(
      "select id, role, is_active from admin_users where lower(email) = $1",
      [email],
    ),
  )
  const row = existing.rows[0]
  // A password is needed for a new admin, or an existing one with --reset-password.
  const needsPassword = !row || options.resetPassword

  let credentialsPath: string | null = null
  let password: string | null = null
  if (needsPassword) {
    if (passwordGiven) {
      password = options.password as string
    } else {
      if (!options.credentialsFile) {
        throw new SeedSuperAdminError(
          "SUPER_ADMIN_CREDENTIALS_FILE is required when SUPER_ADMIN_PASSWORD is not set (the generated password is written only there).",
        )
      }
      // Validate the destination before touching the database.
      credentialsPath = await assertCredentialsPathOutsideRepo(options.credentialsFile, repoRoot)
      password = generateStrongPassword()
    }
  }

  const passwordHash = password ? await hashPassword(password) : null

  // Write the generated password first: if that fails (file exists, bad
  // directory) nothing in the database has changed and it can be re-run. If
  // the database step then fails, the file is removed again.
  if (credentialsPath && password) await writeCredentialsFile(credentialsPath, email, password)

  const result = await applySeed(db, row, email, passwordHash, options.name).catch(async (err: unknown) => {
    if (credentialsPath) await unlink(credentialsPath).catch(() => undefined)
    throw err
  })

  return {
    adminUserId: result.adminUserId,
    email,
    action: result.action,
    passwordSet: Boolean(passwordHash),
    credentialsFileWritten: credentialsPath,
  }
}

async function applySeed(
  db: Pool,
  row: { id: string } | undefined,
  email: string,
  passwordHash: string | null,
  name: string | undefined,
): Promise<{ adminUserId: string; action: SeedSuperAdminResult["action"] }> {
  return runWithSystemContext(async () => {
    const client = await db.connect()
    try {
      await client.query("begin")
      let adminUserId: string
      let action: SeedSuperAdminResult["action"]
      if (!row) {
        const { rows } = await client.query<{ id: string }>(
          `insert into admin_users (email, password_hash, name, role, is_active)
           values ($1, $2, $3, 'super_admin', true) returning id`,
          [email, passwordHash, (name || "Super Admin").trim().slice(0, 120)],
        )
        adminUserId = rows[0].id
        action = "created"
      } else {
        adminUserId = row.id
        const { rows: locked } = await client.query<{ role: string; is_active: boolean }>(
          "select role, is_active from admin_users where id = $1 for update",
          [adminUserId],
        )
        const alreadySuper = locked[0]?.role === "super_admin" && locked[0]?.is_active
        await client.query("update admin_users set role = 'super_admin', is_active = true where id = $1", [adminUserId])
        if (passwordHash) {
          await client.query("update admin_users set password_hash = $1 where id = $2", [passwordHash, adminUserId])
          await revokeAllAdminSessions(client, adminUserId)
        }
        action = alreadySuper && !passwordHash ? "unchanged" : "promoted"
      }
      await client.query(
        "insert into admin_audit_log (admin_user_id, action, target_user_id, detail) values ($1, $2, null, $3)",
        [adminUserId, "seed_super_admin", JSON.stringify({ action, passwordSet: Boolean(passwordHash), source: "script" })],
      )
      await client.query("commit")
      return { adminUserId, action }
    } catch (err) {
      await client.query("rollback").catch(() => undefined)
      throw err
    } finally {
      client.release()
    }
  })
}

async function main(): Promise<number> {
  const { pool } = await import("../src/lib/db.js")
  const { log } = await import("../src/lib/logger.js")
  if (!pool) {
    log().error({}, "DATABASE_URL / SYSTEM_DATABASE_URL / JWT_SECRET not configured")
    return 1
  }
  try {
    const result = await seedSuperAdmin(pool, {
      email: process.env.SUPER_ADMIN_EMAIL,
      password: process.env.SUPER_ADMIN_PASSWORD,
      credentialsFile: process.env.SUPER_ADMIN_CREDENTIALS_FILE,
      resetPassword: process.argv.includes("--reset-password"),
      name: process.env.SUPER_ADMIN_NAME,
    })
    // Never the password; the credentials file path only when one was written.
    log().info(
      {
        adminUserId: result.adminUserId,
        email: result.email,
        action: result.action,
        passwordSet: result.passwordSet,
        credentialsFile: result.credentialsFileWritten,
      },
      "super admin seeded",
    )
    return 0
  } catch (err) {
    if (err instanceof SeedSuperAdminError) {
      log().error({}, err.message)
      return 1
    }
    if (err && typeof err === "object" && (err as { code?: string }).code === "EEXIST") {
      log().error({}, "SUPER_ADMIN_CREDENTIALS_FILE already exists; refusing to overwrite it.")
      return 1
    }
    throw err
  } finally {
    await pool.end()
  }
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (invokedDirectly) {
  main().then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(err instanceof Error ? err.message : "seed-super-admin failed")
      process.exit(1)
    },
  )
}
