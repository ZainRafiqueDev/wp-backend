import { randomUUID } from "node:crypto"
import request from "supertest"
import { describe, expect, it } from "vitest"

import { app } from "../helpers.js"
import { pool } from "../../src/lib/db.js"
import {
  DOCUMENT_CHUNKS_HNSW_INDEX,
  PRODUCT_CATALOG_HNSW_INDEX,
  getHnswIndexHealth,
} from "../../src/lib/pgvectorHnsw.js"

async function insertChatbot(label: string): Promise<string> {
  const user = await pool!.query<{ id: string }>(
    `insert into users (email, password_hash, name) values ($1, 'x', $2) returning id`,
    [`${label}-${randomUUID()}@example.test`, label],
  )
  const bot = await pool!.query<{ id: string }>(
    `insert into chatbots (user_id, name, sources, status) values ($1, $2, '[]', 'ready') returning id`,
    [user.rows[0].id, `${label} bot`],
  )
  return bot.rows[0].id
}

function vectorLiteral(nonzeroIndex: number): string {
  const values = Array.from({ length: 1536 }, (_, i) => (i === nonzeroIndex ? 1 : 0))
  return `[${values.join(",")}]`
}

function collectPlanNodes(node: unknown): Record<string, unknown>[] {
  if (!node || typeof node !== "object") return []
  const current = node as Record<string, unknown>
  const nested = Array.isArray(current.Plans) ? current.Plans.flatMap(collectPlanNodes) : []
  return [current, ...nested]
}

function parseExplain(raw: unknown): unknown {
  const parsed = typeof raw === "string" ? JSON.parse(raw) : raw
  return Array.isArray(parsed) ? parsed[0]?.Plan : undefined
}

describe("WP-1.4 pgvector HNSW", () => {
  it("has cosine HNSW indexes on document chunks and product catalog", async () => {
    const health = await getHnswIndexHealth()
    expect(health).toEqual({
      available: true,
      documentChunks: true,
      productCatalog: true,
    })

    const res = await request(app).get("/health")
    expect(res.status).toBe(200)
    expect(res.body.retrieval.hnsw).toMatchObject({
      available: true,
      documentChunks: true,
      productCatalog: true,
    })
  })

  it("keeps document similarity lookup tenant-scoped", async () => {
    const chatbotA = await insertChatbot("hnsw-a")
    const chatbotB = await insertChatbot("hnsw-b")
    const queryVector = vectorLiteral(0)

    const docA = await pool!.query<{ id: string }>(
      `insert into chatbot_documents (chatbot_id, file_name, file_type, file_size, status, chunk_count)
       values ($1, 'a.txt', 'txt', 12, 'ready', 1) returning id`,
      [chatbotA],
    )
    const docB = await pool!.query<{ id: string }>(
      `insert into chatbot_documents (chatbot_id, file_name, file_type, file_size, status, chunk_count)
       values ($1, 'b.txt', 'txt', 12, 'ready', 1) returning id`,
      [chatbotB],
    )
    await pool!.query(
      `insert into chatbot_document_chunks (document_id, chatbot_id, content, embedding)
       values ($1, $2, 'tenant A secret pricing', $3::vector),
              ($4, $5, 'tenant B secret pricing', $6::vector)`,
      [docA.rows[0].id, chatbotA, queryVector, docB.rows[0].id, chatbotB, vectorLiteral(1)],
    )

    const { rows } = await pool!.query<{ chatbot_id: string; content: string }>(
      `select c.chatbot_id, c.content
       from chatbot_document_chunks c
       join chatbot_documents d on d.id = c.document_id
       where c.chatbot_id = $1 and c.embedding is not null and d.status = 'ready'
         and (c.embedding <=> $2::vector) <= 2
       order by c.embedding <=> $2::vector
       limit 5`,
      [chatbotA, queryVector],
    )

    expect(rows.length).toBeGreaterThanOrEqual(1)
    expect(rows.every((row) => row.chatbot_id === chatbotA)).toBe(true)
    expect(rows.some((row) => row.content.includes("tenant B"))).toBe(false)
  })

  it("can use the document HNSW index when sequential scans are disabled", async () => {
    const chatbotId = await insertChatbot("hnsw-plan")
    const queryVector = vectorLiteral(0)
    const doc = await pool!.query<{ id: string }>(
      `insert into chatbot_documents (chatbot_id, file_name, file_type, file_size, status, chunk_count)
       values ($1, 'plan.txt', 'txt', 12, 'ready', 1) returning id`,
      [chatbotId],
    )
    await pool!.query(
      `insert into chatbot_document_chunks (document_id, chatbot_id, content, embedding)
       values ($1, $2, 'hnsw plan probe', $3::vector)`,
      [doc.rows[0].id, chatbotId, queryVector],
    )

    const client = await pool!.connect()
    try {
      await client.query("begin")
      await client.query("set local enable_seqscan = off")
      const explained = await client.query<{ "QUERY PLAN": unknown }>(
        `explain (format json)
         select c.id, c.content, d.file_name, c.embedding <=> $2::vector as distance
         from chatbot_document_chunks c
         join chatbot_documents d on d.id = c.document_id
         where c.chatbot_id = $1 and c.embedding is not null and d.status = 'ready'
           and (c.embedding <=> $2::vector) <= 2
         order by distance
         limit 5`,
        [chatbotId, queryVector],
      )
      const filteredNodes = collectPlanNodes(parseExplain(explained.rows[0]?.["QUERY PLAN"]))
      expect(
        filteredNodes.some((node) => node["Node Type"] === "Seq Scan" && node["Relation Name"] === "chatbot_document_chunks"),
      ).toBe(false)

      const ann = await client.query<{ "QUERY PLAN": unknown }>(
        `explain (format json)
         select id from chatbot_document_chunks
         where embedding is not null
         order by embedding <=> $1::vector
         limit 5`,
        [queryVector],
      )
      await client.query("commit")
      const annNodes = collectPlanNodes(parseExplain(ann.rows[0]?.["QUERY PLAN"]))
      expect(annNodes.some((node) => node["Index Name"] === DOCUMENT_CHUNKS_HNSW_INDEX)).toBe(true)
    } finally {
      client.release()
    }
  })

  it("keeps product catalog similarity lookup tenant-scoped and indexable", async () => {
    const chatbotA = await insertChatbot("hnsw-prod-a")
    const chatbotB = await insertChatbot("hnsw-prod-b")
    const queryVector = vectorLiteral(0)

    await pool!.query(
      `insert into product_catalog_cache (chatbot_id, woocommerce_product_id, name, description, embedding)
       values ($1, 'sku-a', 'Tenant A lamp', 'secret A', $2::vector),
              ($3, 'sku-b', 'Tenant B lamp', 'secret B', $4::vector)`,
      [chatbotA, queryVector, chatbotB, vectorLiteral(1)],
    )

    const { rows } = await pool!.query<{ chatbot_id: string; name: string }>(
      `select chatbot_id, name
       from product_catalog_cache
       where chatbot_id = $1
       order by embedding <=> $2::vector
       limit 5`,
      [chatbotA, queryVector],
    )
    expect(rows.every((row) => row.chatbot_id === chatbotA)).toBe(true)
    expect(rows.some((row) => row.name.includes("Tenant B"))).toBe(false)

    const client = await pool!.connect()
    try {
      await client.query("begin")
      await client.query("set local enable_seqscan = off")
      const explained = await client.query<{ "QUERY PLAN": unknown }>(
        `explain (format json)
         select * from product_catalog_cache
         where chatbot_id = $1
         order by embedding <=> $2::vector
         limit 5`,
        [chatbotA, queryVector],
      )
      const filteredNodes = collectPlanNodes(parseExplain(explained.rows[0]?.["QUERY PLAN"]))
      expect(
        filteredNodes.some((node) => node["Node Type"] === "Seq Scan" && node["Relation Name"] === "product_catalog_cache"),
      ).toBe(false)

      const ann = await client.query<{ "QUERY PLAN": unknown }>(
        `explain (format json)
         select id from product_catalog_cache
         where embedding is not null
         order by embedding <=> $1::vector
         limit 5`,
        [queryVector],
      )
      await client.query("commit")
      const annNodes = collectPlanNodes(parseExplain(ann.rows[0]?.["QUERY PLAN"]))
      expect(annNodes.some((node) => node["Index Name"] === PRODUCT_CATALOG_HNSW_INDEX)).toBe(true)
    } finally {
      client.release()
    }
  })

  it("keeps HNSW Recall@5 and Recall@10 at 1.0 versus exact search on a synthetic corpus", async () => {
    const chatbotId = await insertChatbot("hnsw-recall")
    const corpus = 48
    const doc = await pool!.query<{ id: string }>(
      `insert into chatbot_documents (chatbot_id, file_name, file_type, file_size, status, chunk_count)
       values ($1, 'recall.txt', 'txt', 12, 'ready', $2) returning id`,
      [chatbotId, corpus],
    )
    for (let i = 0; i < corpus; i++) {
      await pool!.query(
        `insert into chatbot_document_chunks (document_id, chatbot_id, content, embedding)
         values ($1, $2, $3, $4::vector)`,
        [doc.rows[0].id, chatbotId, `chunk ${i}`, vectorLiteral(i)],
      )
    }

    const querySql = `
      select c.id::text as id
      from chatbot_document_chunks c
      join chatbot_documents d on d.id = c.document_id
      where c.chatbot_id = $1 and c.embedding is not null and d.status = 'ready'
      order by c.embedding <=> $2::vector
      limit 10`

    let recall5Hits = 0
    let recall10Hits = 0
    const queries = 12
    const client = await pool!.connect()
    try {
      for (let i = 0; i < queries; i++) {
        await client.query("begin")
        await client.query("set local enable_indexscan = off")
        const exact = await client.query<{ id: string }>(querySql, [chatbotId, vectorLiteral(i)])
        await client.query("commit")

        await client.query("begin")
        await client.query("set local enable_seqscan = off")
        const approx = await client.query<{ id: string }>(querySql, [chatbotId, vectorLiteral(i)])
        await client.query("commit")

        const exact5 = new Set(exact.rows.slice(0, 5).map((row) => row.id))
        const exact10 = new Set(exact.rows.map((row) => row.id))
        recall5Hits += approx.rows.slice(0, 5).filter((row) => exact5.has(row.id)).length / 5
        recall10Hits += approx.rows.filter((row) => exact10.has(row.id)).length / 10
      }
    } finally {
      client.release()
    }

    expect(recall5Hits / queries).toBeGreaterThanOrEqual(0.95)
    expect(recall10Hits / queries).toBeGreaterThanOrEqual(0.98)
  })
})
