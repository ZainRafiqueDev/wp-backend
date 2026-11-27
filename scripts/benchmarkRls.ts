/**
 * One-shot SET LOCAL overhead vs a bare SELECT 1.
 * Usage: npx tsx scripts/benchmarkRls.ts
 *
 * Windows: Docker Postgres on localhost is IPv6/wslrelay-flaky; prefer 127.0.0.1.
 */
export {}

// CS-15: no built-in credential. Point DATABASE_URL at chatmate360_app with
// the password you set locally (alter role chatmate360_app with password ...).
if (!process.env.DATABASE_URL) {
  throw new Error("Set DATABASE_URL to the chatmate360_app role (no default password is shipped).")
}
process.env.DATABASE_URL = process.env.DATABASE_URL.replace("@localhost:", "@127.0.0.1:")

const { pool } = await import("../src/lib/db.js")
const { runWithTenantContext } = await import("../src/lib/tenantContext.js")

const ROUNDS = 80

async function time(label: string, fn: () => Promise<void>): Promise<number> {
  const start = performance.now()
  await fn()
  const elapsed = performance.now() - start
  console.log(`${label}: ${elapsed.toFixed(1)}ms total, ${(elapsed / ROUNDS).toFixed(2)}ms/query over ${ROUNDS} queries`)
  return elapsed
}

if (!pool) {
  throw new Error("Set DATABASE_URL")
}

const chatbotId = "00000000-0000-4000-8000-000000000001"

await time("wrapped pool.query (BEGIN + SET LOCAL + SELECT 1 + COMMIT)", async () => {
  await runWithTenantContext({ scope: "worker", chatbotId }, async () => {
    for (let i = 0; i < ROUNDS; i++) {
      await pool!.query("select 1")
    }
  })
})

await pool.end()
