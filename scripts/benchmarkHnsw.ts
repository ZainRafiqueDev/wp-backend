import "dotenv/config"

import { randomUUID } from "node:crypto"
import { Pool } from "pg"

import { DOCUMENT_CHUNKS_HNSW_INDEX } from "../src/lib/pgvectorHnsw.js"

const DIM = 1536
const CORPUS = 400
const QUERIES = 20
const LATENCY_RUNS = 40
const EF_SEARCH = Number(process.env.PGVECTOR_HNSW_EF_SEARCH || 40)

function unitVector(seed: number): number[] {
  const values = Array.from({ length: DIM }, (_, i) => Math.sin(seed * 997 + i * 13))
  const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0)) || 1
  return values.map((value) => value / norm)
}

function vectorLiteral(values: number[]): string {
  return `[${values.join(",")}]`
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  return sorted[Math.max(0, index)]
}

function recallAtK(exact: string[], approx: string[], k: number): number {
  const want = new Set(exact.slice(0, k))
  const got = approx.slice(0, k)
  let hits = 0
  for (const id of got) if (want.has(id)) hits += 1
  return want.size === 0 ? 1 : hits / want.size
}

function collectNodes(node: unknown): Record<string, unknown>[] {
  if (!node || typeof node !== "object") return []
  const current = node as Record<string, unknown>
  const nested = Array.isArray(current.Plans) ? current.Plans.flatMap(collectNodes) : []
  return [current, ...nested]
}

function summarizePlan(raw: unknown): string {
  const parsed = typeof raw === "string" ? JSON.parse(raw) : raw
  const root = Array.isArray(parsed) ? parsed[0] : parsed
  const plan = (root as { Plan?: unknown })?.Plan
  const exec = (root as { "Execution Time"?: number })?.["Execution Time"]
  const nodes = collectNodes(plan)
    .map((node) => {
      const index = node["Index Name"] ? ` ${node["Index Name"]}` : ""
      return `${node["Node Type"]}${index}`
    })
    .join(" → ")
  return `${nodes} (${typeof exec === "number" ? exec.toFixed(2) : "?"} ms)`
}

async function main() {
  const connectionString =
    process.env.TEST_DATABASE_URL ||
    process.env.DATABASE_URL ||
    "postgresql://postgres:postgres@localhost:5435/chatmate360_test"
  const db = new Pool({ connectionString })
  const chatbotId = randomUUID()
  const userId = randomUUID()

  try {
    await db.query(`insert into users (id, email, password_hash, name) values ($1, $2, 'x', 'hnsw bench')`, [
      userId,
      `hnsw-bench-${randomUUID()}@example.test`,
    ])
    await db.query(`insert into chatbots (id, user_id, name, sources, status) values ($1, $2, 'hnsw bench', '[]', 'ready')`, [
      chatbotId,
      userId,
    ])
    const document = await db.query<{ id: string }>(
      `insert into chatbot_documents (chatbot_id, file_name, file_type, file_size, status, chunk_count)
       values ($1, 'bench.txt', 'txt', 12, 'ready', $2) returning id`,
      [chatbotId, CORPUS],
    )

    const vectors = Array.from({ length: CORPUS }, (_, i) => unitVector(i + 1))
    for (let i = 0; i < vectors.length; i++) {
      await db.query(
        `insert into chatbot_document_chunks (document_id, chatbot_id, content, embedding)
         values ($1, $2, $3, $4::vector)`,
        [document.rows[0].id, chatbotId, `chunk ${i}`, vectorLiteral(vectors[i])],
      )
    }

    const querySql = `
      select c.id::text as id
      from chatbot_document_chunks c
      join chatbot_documents d on d.id = c.document_id
      where c.chatbot_id = $1 and c.embedding is not null and d.status = 'ready'
      order by c.embedding <=> $2::vector
      limit 10`

    const seqTimes: number[] = []
    const hnswTimes: number[] = []
    const recall5: number[] = []
    const recall10: number[] = []
    let tenantLeak = 0

    const other = await db.query<{ id: string }>(
      `select id::text as id from chatbot_document_chunks where chatbot_id <> $1 and embedding is not null limit 1`,
      [chatbotId],
    )

    for (let q = 0; q < QUERIES; q++) {
      const query = vectorLiteral(vectors[q])
      const exactClient = await db.connect()
      try {
        await exactClient.query("begin")
        await exactClient.query("set local enable_indexscan = off")
        const started = Date.now()
        const exact = await exactClient.query<{ id: string }>(querySql, [chatbotId, query])
        seqTimes.push(Date.now() - started)
        await exactClient.query("commit")

        await exactClient.query("begin")
        await exactClient.query("set local enable_seqscan = off")
        await exactClient.query("select set_config('hnsw.ef_search', $1, true)", [String(EF_SEARCH)])
        const hnswStarted = Date.now()
        const approx = await exactClient.query<{ id: string }>(querySql, [chatbotId, query])
        hnswTimes.push(Date.now() - hnswStarted)
        await exactClient.query("commit")

        recall5.push(recallAtK(exact.rows.map((row) => row.id), approx.rows.map((row) => row.id), 5))
        recall10.push(recallAtK(exact.rows.map((row) => row.id), approx.rows.map((row) => row.id), 10))
        if (other.rows[0] && approx.rows.some((row) => row.id === other.rows[0].id)) tenantLeak += 1
      } finally {
        exactClient.release()
      }
    }

    for (let i = QUERIES; i < LATENCY_RUNS; i++) {
      const query = vectorLiteral(vectors[i % CORPUS])
      const client = await db.connect()
      try {
        await client.query("begin")
        await client.query("set local enable_indexscan = off")
        const started = Date.now()
        await client.query(querySql, [chatbotId, query])
        seqTimes.push(Date.now() - started)
        await client.query("commit")

        await client.query("begin")
        await client.query("set local enable_seqscan = off")
        await client.query("select set_config('hnsw.ef_search', $1, true)", [String(EF_SEARCH)])
        const hnswStarted = Date.now()
        await client.query(querySql, [chatbotId, query])
        hnswTimes.push(Date.now() - hnswStarted)
        await client.query("commit")
      } finally {
        client.release()
      }
    }

    const client = await db.connect()
    let seqSummary = ""
    let hnswSummary = ""
    let annOnlyUsesHnsw = false
    try {
      const probe = vectorLiteral(vectors[0])
      await client.query("begin")
      await client.query("set local enable_indexscan = off")
      const before = await client.query<{ "QUERY PLAN": unknown }>(
        `explain (analyze, format json) ${querySql}`,
        [chatbotId, probe],
      )
      seqSummary = summarizePlan(before.rows[0]?.["QUERY PLAN"])
      await client.query("commit")

      await client.query("begin")
      await client.query("set local enable_seqscan = off")
      await client.query("select set_config('hnsw.ef_search', $1, true)", [String(EF_SEARCH)])
      const after = await client.query<{ "QUERY PLAN": unknown }>(
        `explain (analyze, format json) ${querySql}`,
        [chatbotId, probe],
      )
      hnswSummary = summarizePlan(after.rows[0]?.["QUERY PLAN"])
      await client.query("commit")

      await client.query("begin")
      await client.query("set local enable_seqscan = off")
      const ann = await client.query<{ "QUERY PLAN": unknown }>(
        `explain (analyze, format json)
         select id from chatbot_document_chunks
         where embedding is not null
         order by embedding <=> $1::vector
         limit 10`,
        [probe],
      )
      const annSummary = summarizePlan(ann.rows[0]?.["QUERY PLAN"])
      annOnlyUsesHnsw = annSummary.includes(DOCUMENT_CHUNKS_HNSW_INDEX)
      await client.query("commit")
    } finally {
      client.release()
    }

    seqTimes.sort((a, b) => a - b)
    hnswTimes.sort((a, b) => a - b)
    const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length

    const result = {
      collectedAt: new Date().toISOString(),
      database: connectionString.replace(/:[^:@]+@/, ":***@"),
      corpus: CORPUS,
      queries: QUERIES,
      efSearch: EF_SEARCH,
      recallAt5: Number(mean(recall5).toFixed(4)),
      recallAt10: Number(mean(recall10).toFixed(4)),
      tenantLeakCount: tenantLeak,
      tenantFilteredPrefersBtree: !hnswSummary.includes(DOCUMENT_CHUNKS_HNSW_INDEX),
      annOnlyUsesHnsw,
      latencyMs: {
        seq: { p50: percentile(seqTimes, 50), p95: percentile(seqTimes, 95), mean: Number(mean(seqTimes).toFixed(2)) },
        hnsw: { p50: percentile(hnswTimes, 50), p95: percentile(hnswTimes, 95), mean: Number(mean(hnswTimes).toFixed(2)) },
      },
      seqPlan: seqSummary,
      tenantFilteredPlan: hnswSummary,
    }

    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  } finally {
    await db.query("delete from users where id = $1", [userId]).catch(() => undefined)
    await db.end()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
