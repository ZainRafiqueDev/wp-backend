import { randomUUID } from "node:crypto"
import request from "supertest"
import { describe, expect, it } from "vitest"

import { testAccessToken } from "../helpers/testSession.js"
import { pool } from "../../src/lib/db.js"
import { app } from "../helpers.js"

const CRAWL_PLUS_MAX_DOCUMENTS = 6
const CRAWL_PLUS_MAX_FILE_BYTES = 16 * 1024 * 1024

async function seedChatbot(
  label: string,
  plan: "free" | "crawl_plus" | "full_custom",
): Promise<{ token: string; chatbotId: string; userId: string }> {
  const user = await pool!.query<{ id: string }>(
    `insert into users (email, password_hash, name, email_verified) values ($1, 'x', $2, true) returning id`,
    [`${label}-${randomUUID()}@example.test`, label],
  )
  const bot = await pool!.query<{ id: string }>(
    `insert into chatbots (user_id, name, sources, status) values ($1, $2, '[]', 'ready') returning id`,
    [user.rows[0].id, `${label} bot`],
  )
  if (plan !== "free") {
    await pool!.query(
      `insert into subscriptions (user_id, stripe_customer_id, plan, status) values ($1, $2, $3, 'active')`,
      [user.rows[0].id, `cus_${label}_${randomUUID()}`, plan],
    )
  }
  return { token: await testAccessToken(user.rows[0].id), chatbotId: bot.rows[0].id, userId: user.rows[0].id }
}

describe("Phase 1: Crawl Plus document limits (6 docs / 16MB / 50MB)", () => {
  it("accepts the 6th document and rejects the 7th with 409 DOC_LIMIT_REACHED", async () => {
    const { token, chatbotId } = await seedChatbot("crawl-plus-count", "crawl_plus")

    for (let i = 0; i < CRAWL_PLUS_MAX_DOCUMENTS; i++) {
      const res = await request(app)
        .post(`/chatbots/${chatbotId}/documents`)
        .set("Authorization", `Bearer ${token}`)
        .attach("file", Buffer.from(`doc number ${i}\n`), `doc-${i}.txt`)
      expect(res.status).toBeLessThan(300)
    }

    const seventh = await request(app)
      .post(`/chatbots/${chatbotId}/documents`)
      .set("Authorization", `Bearer ${token}`)
      .attach("file", Buffer.from("seventh\n"), "seventh.txt")

    expect(seventh.status).toBe(409)
    expect(seventh.body).toMatchObject({
      ok: false,
      cap: "documents",
      code: "DOC_LIMIT_REACHED",
      data: { used: CRAWL_PLUS_MAX_DOCUMENTS, limit: CRAWL_PLUS_MAX_DOCUMENTS },
    })

    const { rows } = await pool!.query<{ count: string }>(
      `select count(*)::text as count from chatbot_documents where chatbot_id = $1`,
      [chatbotId],
    )
    expect(Number(rows[0].count)).toBe(CRAWL_PLUS_MAX_DOCUMENTS)
  })

  it("accepts a file at exactly 16MB and rejects 16MB + 1 byte with 413 FILE_TOO_LARGE", async () => {
    const { token, chatbotId } = await seedChatbot("crawl-plus-filesize", "crawl_plus")

    const atLimit = Buffer.alloc(CRAWL_PLUS_MAX_FILE_BYTES, 1)
    const okRes = await request(app)
      .post(`/chatbots/${chatbotId}/documents`)
      .set("Authorization", `Bearer ${token}`)
      .attach("file", atLimit, "at-limit.txt")
    expect(okRes.status).toBeLessThan(300)

    const overLimit = Buffer.alloc(CRAWL_PLUS_MAX_FILE_BYTES + 1, 2)
    const res = await request(app)
      .post(`/chatbots/${chatbotId}/documents`)
      .set("Authorization", `Bearer ${token}`)
      .attach("file", overLimit, "over-limit.txt")

    expect(res.status).toBe(413)
    expect(res.body).toMatchObject({
      ok: false,
      cap: "bytes",
      code: "FILE_TOO_LARGE",
      data: { limit: CRAWL_PLUS_MAX_FILE_BYTES },
    })

    const { rows } = await pool!.query<{ count: string }>(
      `select count(*)::text as count from chatbot_documents where chatbot_id = $1`,
      [chatbotId],
    )
    expect(Number(rows[0].count)).toBe(1)
  })

  it("serializes two concurrent uploads at 5 existing documents so exactly one succeeds", async () => {
    const { token, chatbotId } = await seedChatbot("crawl-plus-race", "crawl_plus")
    for (let i = 0; i < CRAWL_PLUS_MAX_DOCUMENTS - 1; i++) {
      await pool!.query(
        `insert into chatbot_documents (chatbot_id, file_name, file_type, file_size, status, chunk_count)
         values ($1, $2, 'txt', 12, 'ready', 1)`,
        [chatbotId, `existing-${i}.txt`],
      )
    }

    const responses = await Promise.all([
      request(app)
        .post(`/chatbots/${chatbotId}/documents`)
        .set("Authorization", `Bearer ${token}`)
        .attach("file", Buffer.from("race a\n"), "race-a.txt"),
      request(app)
        .post(`/chatbots/${chatbotId}/documents`)
        .set("Authorization", `Bearer ${token}`)
        .attach("file", Buffer.from("race b\n"), "race-b.txt"),
    ])

    const succeeded = responses.filter((r) => r.status < 300)
    const rejected = responses.filter((r) => r.status === 409)
    expect(succeeded).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect(rejected[0].body.code).toBe("DOC_LIMIT_REACHED")

    const { rows } = await pool!.query<{ count: string }>(
      `select count(*)::text as count from chatbot_documents where chatbot_id = $1`,
      [chatbotId],
    )
    expect(Number(rows[0].count)).toBe(CRAWL_PLUS_MAX_DOCUMENTS)
  })

  it("a duplicate upload (same bytes) is rejected and never spends a slot", async () => {
    const { token, chatbotId } = await seedChatbot("crawl-plus-dedup", "crawl_plus")
    const body = Buffer.from("identical bytes for dedup probe\n")

    const first = await request(app)
      .post(`/chatbots/${chatbotId}/documents`)
      .set("Authorization", `Bearer ${token}`)
      .attach("file", body, "first.txt")
    expect(first.status).toBeLessThan(300)

    const duplicate = await request(app)
      .post(`/chatbots/${chatbotId}/documents`)
      .set("Authorization", `Bearer ${token}`)
      .attach("file", body, "same-bytes-different-name.txt")

    expect(duplicate.status).toBe(409)
    expect(duplicate.body).toMatchObject({ ok: false, code: "DUPLICATE_FILE" })

    const { rows } = await pool!.query<{ count: string }>(
      `select count(*)::text as count from chatbot_documents where chatbot_id = $1`,
      [chatbotId],
    )
    expect(Number(rows[0].count)).toBe(1)
  })

  it("re-uploading the same bytes after the original failed is allowed (failed doesn't block dedup)", async () => {
    const { token, chatbotId } = await seedChatbot("crawl-plus-dedup-failed", "crawl_plus")
    const body = Buffer.from("bytes that will be marked failed\n")
    const hash = (await import("node:crypto")).createHash("sha256").update(body).digest("hex")

    await pool!.query(
      `insert into chatbot_documents (chatbot_id, file_name, file_type, file_size, status, chunk_count, file_hash)
       values ($1, 'failed-original.txt', 'txt', $2, 'failed', 0, $3)`,
      [chatbotId, body.length, hash],
    )

    const res = await request(app)
      .post(`/chatbots/${chatbotId}/documents`)
      .set("Authorization", `Bearer ${token}`)
      .attach("file", body, "retry.txt")

    expect(res.status).toBeLessThan(300)
  })

  it("a failed document does not count toward the 6-document quota", async () => {
    const { token, chatbotId } = await seedChatbot("crawl-plus-failed-excluded", "crawl_plus")
    for (let i = 0; i < CRAWL_PLUS_MAX_DOCUMENTS; i++) {
      await pool!.query(
        `insert into chatbot_documents (chatbot_id, file_name, file_type, file_size, status, chunk_count)
         values ($1, $2, 'txt', 12, 'failed', 0)`,
        [chatbotId, `failed-${i}.txt`],
      )
    }

    const res = await request(app)
      .post(`/chatbots/${chatbotId}/documents`)
      .set("Authorization", `Bearer ${token}`)
      .attach("file", Buffer.from("should still fit\n"), "fits.txt")

    expect(res.status).toBeLessThan(300)
  })

  it("rejects uploads for a Free plan chatbot with 402", async () => {
    const { token, chatbotId } = await seedChatbot("free-plan-docs", "free")

    const res = await request(app)
      .post(`/chatbots/${chatbotId}/documents`)
      .set("Authorization", `Bearer ${token}`)
      .attach("file", Buffer.from("nope\n"), "nope.txt")

    expect(res.status).toBe(402)
  })

  it("a per-chatbot override raises the Crawl Plus document cap", async () => {
    const { token, chatbotId } = await seedChatbot("crawl-plus-override", "crawl_plus")
    await pool!.query(`update chatbots set max_documents = 8 where id = $1`, [chatbotId])

    for (let i = 0; i < 8; i++) {
      const res = await request(app)
        .post(`/chatbots/${chatbotId}/documents`)
        .set("Authorization", `Bearer ${token}`)
        .attach("file", Buffer.from(`override doc ${i}\n`), `override-${i}.txt`)
      expect(res.status).toBeLessThan(300)
    }

    const ninth = await request(app)
      .post(`/chatbots/${chatbotId}/documents`)
      .set("Authorization", `Bearer ${token}`)
      .attach("file", Buffer.from("ninth\n"), "ninth.txt")
    expect(ninth.status).toBe(409)
  })

  it("GET /documents returns caps with used/limit for the dashboard counter", async () => {
    const { token, chatbotId } = await seedChatbot("crawl-plus-caps-summary", "crawl_plus")
    await request(app)
      .post(`/chatbots/${chatbotId}/documents`)
      .set("Authorization", `Bearer ${token}`)
      .attach("file", Buffer.from("one\n"), "one.txt")

    const res = await request(app).get(`/chatbots/${chatbotId}/documents`).set("Authorization", `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.caps).toMatchObject({
      enabled: true,
      maxDocuments: CRAWL_PLUS_MAX_DOCUMENTS,
      maxFileBytes: CRAWL_PLUS_MAX_FILE_BYTES,
      usedDocuments: 1,
    })
  })

  it("a chatbot already over the new limit (grandfathered) keeps all its documents, reports an honest over-limit caps state, and only blocks new uploads", async () => {
    const { token, chatbotId } = await seedChatbot("crawl-plus-grandfathered", "crawl_plus")
    // Simulate documents uploaded back when the cap was higher (pre-dates
    // this phase) — inserted directly, bypassing the HTTP quota check,
    // exactly like a real grandfathered row would already exist as.
    for (let i = 0; i < 9; i++) {
      await pool!.query(
        `insert into chatbot_documents (chatbot_id, file_name, file_type, file_size, status, chunk_count)
         values ($1, $2, 'txt', 12, 'ready', 1)`,
        [chatbotId, `grandfathered-${i}.txt`],
      )
    }

    const listed = await request(app).get(`/chatbots/${chatbotId}/documents`).set("Authorization", `Bearer ${token}`)
    expect(listed.status).toBe(200)
    expect(listed.body.documents).toHaveLength(9)
    expect(listed.body.caps).toMatchObject({
      enabled: true,
      maxDocuments: CRAWL_PLUS_MAX_DOCUMENTS,
      usedDocuments: 9,
    })

    const blocked = await request(app)
      .post(`/chatbots/${chatbotId}/documents`)
      .set("Authorization", `Bearer ${token}`)
      .attach("file", Buffer.from("tenth\n"), "tenth.txt")
    expect(blocked.status).toBe(409)
    expect(blocked.body).toMatchObject({
      ok: false,
      code: "DOC_LIMIT_REACHED",
      data: { used: 9, limit: CRAWL_PLUS_MAX_DOCUMENTS },
    })

    const { rows } = await pool!.query<{ count: string }>(
      `select count(*)::text as count from chatbot_documents where chatbot_id = $1`,
      [chatbotId],
    )
    expect(Number(rows[0].count)).toBe(9)
  })
})
