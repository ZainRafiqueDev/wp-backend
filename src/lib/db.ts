import { Pool, type PoolClient, type QueryResult } from "pg"

import { env, hasDatabase } from "../env.js"
import {
  assertNoDefaultDatabasePassword,
  dbRoleProblems,
  isFatalInProduction,
  SYSTEM_DB_ROLE,
  type DbPoolKind,
  type DbRoleFacts,
} from "./dbGuards.js"
import { baseLogger, log } from "./logger.js"
import {
  getTenantStore,
  logMissingTenantContext,
  resolveTenantGucs,
  tenantContextIsEmpty,
} from "./tenantContext.js"

// CS-15 (B02-009): privileged (admin/system scope) work runs on a separate
// login, chatmate360_system. app.is_privileged() only honours app.scope on
// that role, so SQL running on the tenant role cannot make itself
// privileged with set_config('app.scope', 'system'). Read here rather than
// in env.ts to keep this change self-contained; documented in docs/RLS.md.
const systemDatabaseUrl = (process.env.SYSTEM_DATABASE_URL || "").trim()

const PRIVILEGED_SCOPES = new Set(["admin", "system"])

if (hasDatabase) {
  assertNoDefaultDatabasePassword(env.databaseUrl, "DATABASE_URL", env.nodeEnv)
  if (systemDatabaseUrl) {
    assertNoDefaultDatabasePassword(systemDatabaseUrl, "SYSTEM_DATABASE_URL", env.nodeEnv)
  } else if (env.nodeEnv === "production" && env.rlsEnabled) {
    throw new Error(
      `SYSTEM_DATABASE_URL is not set. Admin and system work (access gate, sweeps, webhooks, admin dashboard) ` +
        `must connect as ${SYSTEM_DB_ROLE}; see docs/RLS.md "Two-role rollout".`,
    )
  }
}

function makePool(connectionString: string): Pool {
  const created = new Pool({
    connectionString,
    max: env.dbPoolMax,
    idleTimeoutMillis: env.dbPoolIdleTimeoutMs,
    connectionTimeoutMillis: env.dbPoolConnectionTimeoutMs,
    statement_timeout: env.dbStatementTimeoutMs,
  })
  created.on("error", (err) => {
    baseLogger.error({ err: err.message }, "db idle client error")
  })
  return created
}

const innerPool: Pool | null = hasDatabase ? makePool(env.databaseUrl) : null
const systemPool: Pool | null = hasDatabase && systemDatabaseUrl ? makePool(systemDatabaseUrl) : null

let nativeConnect: Pool["connect"] | null = innerPool ? innerPool.connect.bind(innerPool) : null
const systemConnect: Pool["connect"] | null = systemPool ? systemPool.connect.bind(systemPool) : null

/**
 * Which login a query runs on. Only an explicit admin/system scope goes to
 * the system pool; an empty or missing context stays on the tenant role,
 * where RLS returns 0 rows (fail closed).
 */
function connectForCurrentScope(): { kind: DbPoolKind; connect: () => Promise<PoolClient> } {
  const scope = resolveTenantGucs().scope
  if (systemConnect && PRIVILEGED_SCOPES.has(scope)) {
    return { kind: "system", connect: systemConnect as () => Promise<PoolClient> }
  }
  if (!nativeConnect) throw new Error("Database pool is not configured.")
  return { kind: "tenant", connect: nativeConnect as () => Promise<PoolClient> }
}

const roleChecks: Partial<Record<DbPoolKind, Promise<void>>> = {}

async function inspectRole(client: PoolClient, kind: DbPoolKind): Promise<void> {
  let row: (DbRoleFacts & { lockdownApplied: boolean }) | undefined
  try {
    const { rows } = await client.query<DbRoleFacts & { lockdownApplied: boolean }>(
      `select current_user as "currentUser",
              coalesce(r.rolsuper, false) as rolsuper,
              coalesce(r.rolbypassrls, false) as rolbypassrls,
              case when to_regrole($1) is null then false
                   else pg_has_role(current_user, $1, 'MEMBER') end as "isSystemMember",
              to_regproc('app.cs15_lockdown_applied') is not null as "lockdownApplied"
         from pg_roles r
        where r.rolname = current_user`,
      [SYSTEM_DB_ROLE],
    )
    row = rows[0]
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (env.nodeEnv === "production") {
      // An unverifiable role is treated like a bad one: fail closed.
      log().error({ event: "rls.role_inspection_failed", pool: kind, err: message }, "could not inspect Postgres RLS role")
      throw new Error(`Refusing ${kind} database connection: could not verify its Postgres role.`)
    }
    log().warn({ err: message }, "could not inspect Postgres RLS role")
    return
  }
  if (!row) {
    if (env.nodeEnv === "production") {
      throw new Error(`Refusing ${kind} database connection: could not verify its Postgres role.`)
    }
    return
  }
  if (!row.lockdownApplied && env.nodeEnv === "production") {
    log().error(
      { event: "rls.lockdown_missing", metric: "rls.lockdown_missing", pool: kind },
      "db/migrations/20261115_rls_2_lockdown.sql has not been applied; app.scope is still self-settable. Run step 3 of docs/RLS.md.",
    )
  }
  for (const problem of dbRoleProblems(kind, row, env.rlsAppRole)) {
    const fatal = env.nodeEnv === "production" && isFatalInProduction(problem)
    log()[fatal ? "error" : "warn"](
      { event: problem.event, metric: problem.event, pool: kind, currentUser: row.currentUser, expectedRole: env.rlsAppRole },
      problem.message,
    )
    // S3-012: in production a pool whose role defeats RLS is refused, not
    // just logged. Every later checkout re-throws the same error.
    if (fatal) throw new Error(`Refusing ${kind} database connection: ${problem.message}`)
  }
}

async function checkRole(client: PoolClient, kind: DbPoolKind): Promise<void> {
  if (!env.rlsEnabled) return
  if (!roleChecks[kind]) {
    // A failed inspection is not cached (refused now, re-inspected on the next
    // checkout); a role found to defeat RLS stays refused for the process.
    roleChecks[kind] = inspectRole(client, kind).catch((err: unknown) => {
      if (err instanceof Error && err.message.includes("could not verify")) roleChecks[kind] = undefined
      throw err
    })
  }
  await roleChecks[kind]
}

function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

function tenantGucSql(isLocal: boolean): string {
  const gucs = resolveTenantGucs()
  if (env.rlsEnabled && tenantContextIsEmpty(gucs)) {
    logMissingTenantContext()
  }
  const loc = isLocal ? "true" : "false"
  return `select
    set_config('app.chatbot_id', ${sqlLiteral(gucs.chatbotId)}, ${loc}),
    set_config('app.user_id', ${sqlLiteral(gucs.userId)}, ${loc}),
    set_config('app.scope', ${sqlLiteral(gucs.scope)}, ${loc}),
    set_config('app.admin_user_id', ${sqlLiteral(gucs.adminUserId)}, ${loc}),
    set_config('app.user_email', ${sqlLiteral(gucs.userEmail)}, ${loc}),
    set_config('app.lookup_hash', ${sqlLiteral(gucs.lookupHash)}, ${loc}),
    set_config('app.google_id', ${sqlLiteral(gucs.googleId)}, ${loc})`
}

function tenantGucKey(): string {
  const gucs = resolveTenantGucs()
  return `${gucs.scope}|${gucs.chatbotId}|${gucs.userId}|${gucs.adminUserId}|${gucs.userEmail}|${gucs.lookupHash}|${gucs.googleId}`
}

export async function applyTenantSettings(
  client: PoolClient,
  queryFn: PoolClient["query"] = client.query.bind(client) as PoolClient["query"],
  isLocal = true,
): Promise<void> {
  await queryFn(tenantGucSql(isLocal))
}

function queryText(arg: unknown): string {
  if (typeof arg === "string") return arg
  if (arg && typeof arg === "object" && "text" in arg && typeof (arg as { text: unknown }).text === "string") {
    return (arg as { text: string }).text
  }
  return ""
}

function emptyResult(command: string): QueryResult {
  return { command, rowCount: null, oid: 0, rows: [], fields: [] }
}

function wrapCheckedOutClient(client: PoolClient): PoolClient {
  const origQuery = client.query.bind(client) as PoolClient["query"]
  const origRelease = client.release.bind(client)
  let open = false
  let released = false
  let appliedKey = ""

  const wrapped = client as PoolClient

  wrapped.query = ((...args: never[]) => {
    const text = queryText(args[0]).trim()
    const begin = /^\s*begin\b/i.test(text)
    const commit = /^\s*commit\b/i.test(text)
    const rollbackTo = /^\s*rollback\s+to\b/i.test(text)
    const rollback = /^\s*rollback\b/i.test(text) && !rollbackTo

    const run = async (): Promise<QueryResult> => {
      if (rollbackTo) {
        return (await (origQuery as (...a: never[]) => Promise<QueryResult>)(...args)) as QueryResult
      }
      if (begin) {
        if (!open) {
          await origQuery(`begin; ${tenantGucSql(true)}`)
          open = true
        } else {
          await origQuery(tenantGucSql(true))
        }
        appliedKey = tenantGucKey()
        return emptyResult("BEGIN")
      }
      if (commit) {
        if (!open) return emptyResult("COMMIT")
        open = false
        appliedKey = ""
        return (await origQuery("COMMIT")) as QueryResult
      }
      if (rollback) {
        if (!open) return emptyResult("ROLLBACK")
        open = false
        appliedKey = ""
        return (await origQuery("ROLLBACK")) as QueryResult
      }
      const key = tenantGucKey()
      if (appliedKey !== key) {
        await origQuery(tenantGucSql(open))
        appliedKey = key
      }
      return (await (origQuery as (...a: never[]) => Promise<QueryResult>)(...args)) as QueryResult
    }

    const last = args[args.length - 1]
    if (typeof last === "function") {
      const cb = last as (err: Error, result?: QueryResult) => void
      void run().then(
        (result) => cb(null as unknown as Error, result),
        (err: Error) => cb(err),
      )
      return undefined
    }
    return run()
  }) as PoolClient["query"]

  wrapped.release = ((err?: Error | boolean) => {
    if (released) return
    released = true
    const store = getTenantStore()
    if (store && store.client === wrapped) {
      store.clientDepth = Math.max(0, store.clientDepth - 1)
      if (store.clientDepth > 0) return
      store.client = undefined
    }
    const releaseArg = typeof err === "boolean" ? undefined : err
    if (!open) {
      origRelease(releaseArg)
      return
    }
    open = false
    void Promise.resolve(origQuery("ROLLBACK"))
      .catch(() => undefined)
      .finally(() => origRelease(releaseArg))
  }) as PoolClient["release"]

  return wrapped
}

async function checkoutTenantClient(): Promise<PoolClient> {
  if (!nativeConnect) throw new Error("Database pool is not configured.")
  const store = getTenantStore()
  if (store?.client) {
    store.clientDepth += 1
    return store.client
  }
  const target = connectForCurrentScope()
  const client = await target.connect()
  try {
    await checkRole(client, target.kind)
    await client.query(tenantGucSql(false))
    const wrapped = wrapCheckedOutClient(client)
    if (store) {
      store.client = wrapped
      store.clientDepth = 1
    }
    return wrapped
  } catch (err) {
    client.release()
    throw err
  }
}

function installPoolHooks(target: Pool): void {
  nativeConnect = nativeConnect ?? target.connect.bind(target)

  target.query = ((...args: never[]) => {
    const last = args[args.length - 1]
    const cb = typeof last === "function" ? (last as (err: Error, result?: QueryResult) => void) : null
    const queryArgs = (cb ? args.slice(0, -1) : args) as never[]

    const run = async (): Promise<QueryResult> => {
      const store = getTenantStore()
      if (store?.client) {
        return (store.client.query as (...a: never[]) => Promise<QueryResult>)(...queryArgs)
      }
      const target = connectForCurrentScope()
      const client = await target.connect()
      try {
        await checkRole(client, target.kind)
        await client.query(`begin; ${tenantGucSql(true)}`)
        const result = await (client.query as (...a: never[]) => Promise<QueryResult>)(...queryArgs)
        await client.query("COMMIT")
        return result
      } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined)
        throw err
      } finally {
        client.release()
      }
    }

    if (cb) {
      void run().then(
        (result) => cb(null as unknown as Error, result),
        (err: Error) => cb(err),
      )
      return undefined
    }
    return run()
  }) as Pool["query"]

  target.connect = ((cb?: (err: Error, client?: PoolClient, done?: (release?: unknown) => void) => void) => {
    const pending = checkoutTenantClient()
    if (cb) {
      void pending.then(
        (client) => cb(null as unknown as Error, client, () => client.release()),
        (err: Error) => cb(err),
      )
      return undefined
    }
    return pending
  }) as Pool["connect"]
}

if (innerPool) installPoolHooks(innerPool)

export const pool: Pool | null = innerPool

/** True when admin/system scopes run on the separate privileged login. */
export const hasSystemPool: boolean = systemPool !== null
