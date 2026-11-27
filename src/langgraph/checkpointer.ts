
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres"
import pg from "pg"

import { env, hasDatabase } from "../env.js"
import { log } from "../lib/logger.js"

let saver: PostgresSaver | null = null
let setupPromise: Promise<void> | null = null

// CS-15 (B02-005): setup() runs CREATE SCHEMA IF NOT EXISTS / CREATE TABLE,
// which the tenant role (chatmate360_app) no longer may. Run it once on the
// privileged login when configured; checkpoint reads/writes stay on
// DATABASE_URL (the checkpoint tables carry no tenant RLS).
async function runCheckpointerSetup(tenantSaver: PostgresSaver): Promise<void> {
  const systemUrl = (process.env.SYSTEM_DATABASE_URL || "").trim()
  if (!systemUrl) {
    log().error(
      { event: "langgraph.setup_without_system_role", metric: "langgraph.setup_without_system_role" },
      "SYSTEM_DATABASE_URL is not set: running LangGraph checkpointer setup on DATABASE_URL. After the CS-15 " +
        "lockdown the tenant role has no CREATE privilege and this fails; set SYSTEM_DATABASE_URL (docs/RLS.md).",
    )
    await tenantSaver.setup()
    return
  }
  const setupSaver = PostgresSaver.fromConnString(systemUrl)
  try {
    await setupSaver.setup()
  } finally {
    await setupSaver.end().catch(() => undefined)
  }
  // Tables setup() just created are owned by the system login; the tenant
  // login still reads/writes checkpoints. Granting is a no-op when an
  // existing owner (e.g. postgres) already granted via db/rls.sql.
  const client = new pg.Client({ connectionString: systemUrl })
  await client.connect()
  try {
    // Only tables still missing the grant: several API/worker processes start
    // at once, and concurrent GRANTs on one table fail with "tuple
    // concurrently updated". If that happens, re-check before failing.
    const missing = async () =>
      (
        await client.query<{ name: string }>(
          `select c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public' and c.relkind = 'r' and pg_get_userbyid(c.relowner) = current_user
              and c.relname in ('checkpoints', 'checkpoint_blobs', 'checkpoint_writes', 'checkpoint_migrations')
              and not (has_table_privilege($1, c.oid, 'SELECT') and has_table_privilege($1, c.oid, 'INSERT')
                       and has_table_privilege($1, c.oid, 'UPDATE') and has_table_privilege($1, c.oid, 'DELETE'))`,
          [env.rlsAppRole],
        )
      ).rows
    for (const row of await missing()) {
      try {
        await client.query(
          `grant select, insert, update, delete on table ${pg.escapeIdentifier(row.name)} to ${pg.escapeIdentifier(env.rlsAppRole)}`,
        )
      } catch (err) {
        if (!(await missing()).some((m) => m.name === row.name)) continue
        throw err
      }
    }
  } finally {
    await client.end().catch(() => undefined)
  }
}

export function hasCommerceCheckpointing(): boolean {
  return hasDatabase
}


export async function getCommerceCheckpointer(): Promise<PostgresSaver> {
  if (!hasDatabase) {
    throw new Error("Database is not configured. Set DATABASE_URL and JWT_SECRET.")
  }
  if (!saver) {
    saver = PostgresSaver.fromConnString(env.databaseUrl)
  }
  if (!setupPromise) {
    setupPromise = runCheckpointerSetup(saver).then(
      () => {
        log().info("langgraph postgres checkpointer set up")
      },
      (err: unknown) => {
        // Never cache a failed setup: the next call retries.
        setupPromise = null
        throw err
      },
    )
  }
  await setupPromise
  return saver
}
