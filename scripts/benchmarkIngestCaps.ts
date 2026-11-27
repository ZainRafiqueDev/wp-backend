import "dotenv/config"

import { randomUUID } from "node:crypto"
import { Pool } from "pg"

const RUNS = 40
const CORPUS = 25

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  return sorted[Math.max(0, index)]
}

function summarize(label: string, samples: number[]): void {
  const sorted = [...samples].sort((a, b) => a - b)
  console.log(
    `${label}: n=${sorted.length} p50=${percentile(sorted, 50).toFixed(2)}ms p95=${percentile(sorted, 95).toFixed(2)}ms max=${sorted[sorted.length - 1]?.toFixed(2) ?? 0}ms`,
  )
}

function planSummary(node: unknown): { nodeType?: string; indexName?: string; actualMs?: number } {
  if (!node || typeof node !== "object") return {}
  const current = node as Record<string, unknown>
  return {
    nodeType: typeof current["Node Type"] === "string" ? (current["Node Type"] as string) : undefined,
    indexName: typeof current["Index Name"] === "string" ? (current["Index Name"] as string) : undefined,
    actualMs: typeof current["Actual Total Time"] === "number" ? (current["Actual Total Time"] as number) : undefined,
  }
}

async function main() {
  const databaseUrl =
    process.env.TEST_DATABASE_URL ||
    process.env.DATABASE_URL ||
    "postgresql://postgres:postgres@localhost:5435/chatmate360_test"
  const pool = new Pool({ connectionString: databaseUrl })

  const user = await pool.query<{ id: string }>(
    `insert into users (email, password_hash, name) values ($1, 'x', 'ingest-bench') returning id`,
    [`ingest-bench-${randomUUID()}@example.test`],
  )
  const bot = await pool.query<{ id: string }>(
    `insert into chatbots (user_id, name, sources, status) values ($1, 'ingest bench', '[]', 'ready') returning id`,
    [user.rows[0].id],
  )
  const chatbotId = bot.rows[0].id

  for (let i = 0; i < CORPUS; i++) {
    await pool.query(
      `insert into chatbot_documents (chatbot_id, file_name, file_type, file_size, status, chunk_count)
       values ($1, $2, 'txt', $3, 'ready', $4)`,
      [chatbotId, `bench-${i}.txt`, 12_000 + i, 8],
    )
  }

  const countOnly: number[] = []
  const countAndSum: number[] = []
  const lockedUsage: number[] = []

  for (let i = 0; i < RUNS; i++) {
    const a = performance.now()
    await pool.query(`select count(*) from chatbot_documents where chatbot_id = $1`, [chatbotId])
    countOnly.push(performance.now() - a)

    const b = performance.now()
    await pool.query(
      `select count(*) as documents, coalesce(sum(file_size), 0) as bytes, coalesce(sum(chunk_count), 0) as chunks
       from chatbot_documents where chatbot_id = $1`,
      [chatbotId],
    )
    countAndSum.push(performance.now() - b)

    const client = await pool.connect()
    try {
      const c = performance.now()
      await client.query("begin")
      await client.query("select id from chatbots where id = $1 for update", [chatbotId])
      await client.query(
        `select count(*) as documents, coalesce(sum(file_size), 0) as bytes, coalesce(sum(chunk_count), 0) as chunks
         from chatbot_documents where chatbot_id = $1`,
        [chatbotId],
      )
      await client.query("commit")
      lockedUsage.push(performance.now() - c)
    } finally {
      client.release()
    }
  }

  const explained = await pool.query<{ "QUERY PLAN": unknown }>(
    `explain (analyze, format json)
     select count(*) as documents, coalesce(sum(file_size), 0) as bytes, coalesce(sum(chunk_count), 0) as chunks
     from chatbot_documents where chatbot_id = $1`,
    [chatbotId],
  )
  const plan = Array.isArray(explained.rows[0]?.["QUERY PLAN"])
    ? (explained.rows[0]["QUERY PLAN"] as { Plan?: unknown }[])[0]?.Plan
    : undefined
  const summary = planSummary(plan)

  const concurrentStarted = performance.now()
  const concurrent = await Promise.all(
    Array.from({ length: 8 }, async () => {
      const client = await pool.connect()
      try {
        await client.query("begin")
        await client.query("select id from chatbots where id = $1 for update", [chatbotId])
        const { rows } = await client.query<{ n: string }>(
          `select count(*)::text as n from chatbot_documents where chatbot_id = $1`,
          [chatbotId],
        )
        await client.query("commit")
        return Number(rows[0].n)
      } finally {
        client.release()
      }
    }),
  )

  console.log("WP-1.5 ingest cap benchmark")
  console.log(`corpus=${CORPUS} documents on one chatbot`)
  summarize("count(*) only (pre-WP-1.5 check)", countOnly)
  summarize("count+sum file_size+chunk_count", countAndSum)
  summarize("FOR UPDATE + count+sum + commit", lockedUsage)
  console.log(
    `explain: node=${summary.nodeType ?? "unknown"} index=${summary.indexName ?? "none"} actual=${summary.actualMs ?? 0}ms`,
  )
  console.log(
    `8 concurrent locked reads: ${concurrent.every((n) => n === CORPUS) ? "consistent" : "DRIFT"} counts=[${concurrent.join(",")}] elapsed=${(performance.now() - concurrentStarted).toFixed(2)}ms`,
  )

  await pool.end()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
