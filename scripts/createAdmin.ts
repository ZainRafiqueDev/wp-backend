
import { hashPassword } from "../src/lib/auth.js"
import { pool } from "../src/lib/db.js"
import { log } from "../src/lib/logger.js"
import { runWithSystemContext } from "../src/lib/tenantContext.js"

async function main() {
  const [name, email, password] = process.argv.slice(2)
  if (!name || !email || !password) {
    log().error({}, "usage: npm run create-admin -- \"Name\" admin@example.com \"password\"")
    process.exit(1)
  }
  if (!pool) {
    log().error({}, "DATABASE_URL/JWT_SECRET not configured")
    process.exit(1)
  }

  const passwordHash = await hashPassword(password)
  try {
    // CS-15: admin_users is reachable only on SYSTEM_DATABASE_URL.
    const db = pool
    const { rows } = await runWithSystemContext(() =>
      db.query<{ id: string }>(
        "insert into admin_users (email, password_hash, name) values ($1, $2, $3) returning id",
        [email.toLowerCase().trim(), passwordHash, name.trim()],
      ),
    )
    log().info({ adminUserId: rows[0].id, email }, "admin user created")
  } catch (err) {
    const isUniqueViolation = Boolean(err && typeof err === "object" && "code" in err && (err as { code?: string }).code === "23505")
    if (isUniqueViolation) {
      log().error({ email }, "an admin user with this email already exists")
    } else {
      throw err
    }
  } finally {
    await pool.end()
  }
}

main()
