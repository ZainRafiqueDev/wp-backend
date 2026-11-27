// CS-15 (B02-005, B03-016, S3-012): boot/connection guards for the two
// Postgres logins. Pure functions so they are unit-testable without a DB;
// src/lib/db.ts calls them.

/** Login that gets admin/system privilege in RLS (app.is_privileged()). */
export const SYSTEM_DB_ROLE = "chatmate360_system"

// Passwords that have shipped in this repo's SQL, compose files or docs, or
// are the stock defaults of the images it uses. Never valid in production.
const KNOWN_DEFAULT_PASSWORDS = new Set(["chatmate360_app", "chatmate360_system", "postgres", "password", "changeme"])

/**
 * Returns a reason string when the URL authenticates with a well-known or
 * self-named password, otherwise null. The password itself is never echoed.
 */
export function defaultPasswordProblem(connectionString: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(connectionString)
  } catch {
    return null
  }
  const user = decodeURIComponent(parsed.username || "")
  const password = decodeURIComponent(parsed.password || "")
  if (!password) return null
  if (password === user) return `the password for role "${user}" equals the role name`
  if (KNOWN_DEFAULT_PASSWORDS.has(password.toLowerCase())) {
    return `role "${user}" uses a well-known default password`
  }
  return null
}

/** Throws in production when a database URL uses a default password. */
export function assertNoDefaultDatabasePassword(connectionString: string, label: string, nodeEnv: string): void {
  if (nodeEnv !== "production") return
  const problem = defaultPasswordProblem(connectionString)
  if (problem) {
    throw new Error(
      `${label}: ${problem}. Set a unique password from your secret store (alter role ... with password) ` +
        "and update the connection string; see docs/RLS.md.",
    )
  }
}

export type DbPoolKind = "tenant" | "system"

export type DbRoleFacts = {
  currentUser: string
  rolsuper: boolean
  rolbypassrls: boolean
  /** Whether current_user is (or is a member of) chatmate360_system. */
  isSystemMember: boolean
}

export type DbRoleProblem = { event: string; message: string }

/**
 * What is wrong with the role a pool connected as. The tenant pool must not
 * be able to bypass RLS or reach the privileged role; the system pool must
 * be the privileged role and must not bypass RLS either (policies, not a
 * bypass, are what scope it).
 */
export function dbRoleProblems(kind: DbPoolKind, facts: DbRoleFacts, expectedTenantRole: string): DbRoleProblem[] {
  const problems: DbRoleProblem[] = []
  if (facts.rolsuper || facts.rolbypassrls) {
    problems.push({
      event: "rls.bypass_role",
      message:
        `Postgres role "${facts.currentUser}" (${kind} pool) bypasses RLS; tenant policies will not bind this ` +
        "process. Point the connection string at a NOSUPERUSER NOBYPASSRLS role.",
    })
  }
  if (kind === "tenant") {
    if (facts.isSystemMember && !facts.rolsuper) {
      problems.push({
        event: "rls.tenant_role_privileged",
        message: `Tenant pool role "${facts.currentUser}" is a member of ${SYSTEM_DB_ROLE}; any SQL could then claim privileged scope.`,
      })
    }
    if (facts.currentUser !== expectedTenantRole) {
      problems.push({
        event: "rls.unexpected_role",
        message: `Connected Postgres role "${facts.currentUser}" is not the configured RLS app role "${expectedTenantRole}".`,
      })
    }
  } else if (!facts.isSystemMember) {
    problems.push({
      event: "rls.system_role_missing",
      message: `SYSTEM_DATABASE_URL role "${facts.currentUser}" is not ${SYSTEM_DB_ROLE}; admin/system queries will see 0 rows.`,
    })
  }
  return problems
}

/** Problems that must stop a production process from using the pool. */
export function isFatalInProduction(problem: DbRoleProblem): boolean {
  return problem.event !== "rls.unexpected_role"
}
