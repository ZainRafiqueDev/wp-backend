import { randomUUID } from "node:crypto"
import request from "supertest"
import { describe, expect, it } from "vitest"

import { testAccessToken } from "../helpers/testSession.js"
import { pool } from "../../src/lib/db.js"
import { app } from "../helpers.js"

// Full Custom, not Crawl Plus — these tests exercise the generic
// lock/concurrency/chunk-cap machinery against the 25-doc / 20MB env
// defaults (see env.ts). Crawl Plus has its own, much smaller defaults
// (6 docs / 16MB / 50MB, see plans.ts) — covered separately in
// crawlPlusDocLimits.integration.test.ts.
async function seedFullCustomChatbot(label: string): Promise<{ token: string; chatbotId: string }> {
  const user = await pool!.query<{ id: string }>(
    `insert into users (email, password_hash, name, email_verified) values ($1, 'x', $2, true) returning id`,
    [`${label}-${randomUUID()}@example.test`, label],
  )
  const bot = await pool!.query<{ id: string }>(
    `insert into chatbots (user_id, name, sources, status) values ($1, $2, '[]', 'ready') returning id`,
    [user.rows[0].id, `${label} bot`],
  )
  await pool!.query(
    `insert into subscriptions (user_id, stripe_customer_id, plan, status) values ($1, $2, 'full_custom', 'active')`,
    [user.rows[0].id, `cus_${label}_${randomUUID()}`],
  )
  return { token: await testAccessToken(user.rows[0].id), chatbotId: bot.rows[0].id }
}

describe("WP-1.5 document ingest caps (Full Custom defaults)", () => {
  it("rejects the 26th document with 409 cap=documents and keeps existing rows", async () => {
    const { token, chatbotId } = await seedFullCustomChatbot("ingest-docs")
    for (let i = 0; i < 25; i++) {
      await pool!.query(
        `insert into chatbot_documents (chatbot_id, file_name, file_type, file_size, status, chunk_count)
         values ($1, $2, 'txt', 12, 'ready', 1)`,
        [chatbotId, `existing-${i}.txt`],
      )
    }

    const res = await request(app)
      .post(`/chatbots/${chatbotId}/documents`)
      .set("Authorization", `Bearer ${token}`)
      .attach("file", Buffer.from("hello from a twenty-sixth file\n"), "extra.txt")

    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({ ok: false, cap: "documents" })

    const { rows } = await pool!.query<{ count: string }>(
      `select count(*)::text as count from chatbot_documents where chatbot_id = $1`,
      [chatbotId],
    )
    expect(Number(rows[0].count)).toBe(25)
  })

  it("rejects an oversize file with 413 FILE_TOO_LARGE before inserting a row", async () => {
    const { token, chatbotId } = await seedFullCustomChatbot("ingest-bytes")
    const oversized = Buffer.alloc(20 * 1024 * 1024 + 1, 97)

    const res = await request(app)
      .post(`/chatbots/${chatbotId}/documents`)
      .set("Authorization", `Bearer ${token}`)
      .attach("file", oversized, "huge.txt")

    expect(res.status).toBe(413)
    expect(res.body).toMatchObject({ ok: false, cap: "bytes", code: "FILE_TOO_LARGE" })

    const { rows } = await pool!.query<{ count: string }>(
      `select count(*)::text as count from chatbot_documents where chatbot_id = $1`,
      [chatbotId],
    )
    expect(Number(rows[0].count)).toBe(0)
  })

  it("rejects a chunk explosion with 409 cap=chunks and does not keep the processing row", async () => {
    const { token, chatbotId } = await seedFullCustomChatbot("ingest-chunks")
    await pool!.query(`update chatbots set max_chunks = 1 where id = $1`, [chatbotId])

    const paragraph = "Document ingest chunk overflow probe. ".repeat(40)
    const body = `${paragraph}\n\n${paragraph}`

    const res = await request(app)
      .post(`/chatbots/${chatbotId}/documents`)
      .set("Authorization", `Bearer ${token}`)
      .attach("file", Buffer.from(body), "explosion.txt")

    // WP-2.1: HTTP persists first (202). The chunk cap still deletes the
    // row; it now runs in processPersistedDocument, not the HTTP handler.
    expect(res.status).toBe(202)
    expect(res.body.document.status).toBe("processing")
    const { processPersistedDocument } = await import("../../src/services/documentIngestion.service.js")
    await expect(processPersistedDocument(res.body.document.id, chatbotId)).rejects.toMatchObject({
      status: 409,
      cap: "chunks",
    })

    const { rows } = await pool!.query<{ count: string }>(
      `select count(*)::text as count from chatbot_documents where chatbot_id = $1`,
      [chatbotId],
    )
    expect(Number(rows[0].count)).toBe(0)
  })

  it("serializes concurrent inserts so the document cap cannot be bypassed", async () => {
    const { chatbotId } = await seedFullCustomChatbot("ingest-race")
    await pool!.query(`update chatbots set max_documents = 2 where id = $1`, [chatbotId])

    async function tryInsert(): Promise<"inserted" | "rejected"> {
      const client = await pool!.connect()
      try {
        await client.query("begin")
        await client.query("select id from chatbots where id = $1 for update", [chatbotId])
        const { rows } = await client.query<{ n: string }>(
          `select count(*)::text as n from chatbot_documents where chatbot_id = $1`,
          [chatbotId],
        )
        if (Number(rows[0].n) >= 2) {
          await client.query("rollback")
          return "rejected"
        }
        await client.query(
          `insert into chatbot_documents (chatbot_id, file_name, file_type, file_size, status)
           values ($1, 'race.txt', 'txt', 12, 'processing')`,
          [chatbotId],
        )
        await client.query("commit")
        return "inserted"
      } catch (err) {
        await client.query("rollback").catch(() => undefined)
        throw err
      } finally {
        client.release()
      }
    }

    const results = await Promise.all(Array.from({ length: 8 }, () => tryInsert()))
    expect(results.filter((result) => result === "inserted")).toHaveLength(2)
    expect(results.filter((result) => result === "rejected")).toHaveLength(6)

    const { rows } = await pool!.query<{ count: string }>(
      `select count(*)::text as count from chatbot_documents where chatbot_id = $1`,
      [chatbotId],
    )
    expect(Number(rows[0].count)).toBe(2)
  })

  it("rejects eight concurrent 26th uploads and leaves the existing 25 rows", async () => {
    const { token, chatbotId } = await seedFullCustomChatbot("ingest-http-race")
    for (let i = 0; i < 25; i++) {
      await pool!.query(
        `insert into chatbot_documents (chatbot_id, file_name, file_type, file_size, status, chunk_count)
         values ($1, $2, 'txt', 12, 'ready', 1)`,
        [chatbotId, `existing-${i}.txt`],
      )
    }

    const responses = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        request(app)
          .post(`/chatbots/${chatbotId}/documents`)
          .set("Authorization", `Bearer ${token}`)
          .attach("file", Buffer.from(`concurrent ${i}\n`), `extra-${i}.txt`),
      ),
    )

    expect(responses.every((res) => res.status === 409 && res.body.cap === "documents")).toBe(true)

    const { rows } = await pool!.query<{ count: string }>(
      `select count(*)::text as count from chatbot_documents where chatbot_id = $1`,
      [chatbotId],
    )
    expect(Number(rows[0].count)).toBe(25)
  })

  it("keeps document-cap rejection latency in the same millisecond band as a simple count", async () => {
    const { token, chatbotId } = await seedFullCustomChatbot("ingest-latency")
    for (let i = 0; i < 25; i++) {
      await pool!.query(
        `insert into chatbot_documents (chatbot_id, file_name, file_type, file_size, status, chunk_count)
         values ($1, $2, 'txt', 12, 'ready', 1)`,
        [chatbotId, `existing-${i}.txt`],
      )
    }

    // CS-17: an absolute p95 over 20 samples is effectively the single
    // slowest request, so a GC pause or the rest of the parallel suite
    // competing for CPU/DB failed this test on its own. Each cap probe is now
    // interleaved with a control request (an authenticated list of the same
    // chatbot's documents — a simple count-sized query through the same
    // auth + DB path), after a warm-up, and the cap rejection must stay in
    // the control's band. A real regression (e.g. an O(documents) scan or
    // parsing the upload before the cap check) still fails both checks.
    const probe = (i: number) =>
      request(app)
        .post(`/chatbots/${chatbotId}/documents`)
        .set("Authorization", `Bearer ${token}`)
        .attach("file", Buffer.from("latency probe\n"), `latency-${i}.txt`)
    const control = () => request(app).get(`/chatbots/${chatbotId}/documents`).set("Authorization", `Bearer ${token}`)

    for (let i = 0; i < 3; i++) {
      await probe(-1 - i)
      await control()
    }

    const samples: number[] = []
    const controlSamples: number[] = []
    for (let i = 0; i < 20; i++) {
      let started = performance.now()
      const res = await probe(i)
      samples.push(performance.now() - started)
      expect(res.status).toBe(409)
      expect(res.body.cap).toBe("documents")

      started = performance.now()
      const ctl = await control()
      controlSamples.push(performance.now() - started)
      expect(ctl.status).toBe(200)
    }

    const pct = (values: number[], q: number) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * q) - 1]
    const p50 = pct(samples, 0.5)
    const p95 = pct(samples, 0.95)
    const controlP50 = pct(controlSamples, 0.5)
    console.log(
      `[ingest-latency] document-cap 409 p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms control p50=${controlP50.toFixed(1)}ms n=20`,
    )
    expect(p50).toBeLessThan(500)
    expect(p50).toBeLessThan(controlP50 * 5 + 100)
  })
})
