import { randomUUID } from "node:crypto"
import request from "supertest"
import { describe, expect, it, vi } from "vitest"

import { testAccessToken } from "../helpers/testSession.js"
import { pool } from "../../src/lib/db.js"
import { getDocumentObject } from "../../src/lib/objectStorage.js"
import { app } from "../helpers.js"

// CS-17 (B09-001): no live provider calls — deterministic fake completions.
vi.mock("../../src/lib/ai.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/ai.js")>()
  const { fakeAnswerQuestion } = await import("../helpers/fakeAi.js")
  return { ...actual, answerQuestion: vi.fn(fakeAnswerQuestion), completeCheaply: vi.fn(async () => null) }
})

vi.mock("../../src/lib/documentQualityCheck.js", () => ({
  verifyExtractedText: async () => ({ ok: true }),
}))

vi.mock("../../src/services/embeddings.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/embeddings.service.js")>()
  return {
    ...actual,
    embedTexts: vi.fn(async (texts: string[]) => texts.map(() => Array(1536).fill(0.01))),
  }
})

async function seedCrawlPlusChatbot(label: string): Promise<{ token: string; chatbotId: string }> {
  const user = await pool!.query<{ id: string }>(
    `insert into users (email, password_hash, name, email_verified) values ($1, 'x', $2, true) returning id`,
    [`${label}-${randomUUID()}@example.test`, label],
  )
  const bot = await pool!.query<{ id: string }>(
    `insert into chatbots (user_id, name, sources, status) values ($1, $2, '[]', 'ready') returning id`,
    [user.rows[0].id, `${label} bot`],
  )
  await pool!.query(
    `insert into subscriptions (user_id, stripe_customer_id, plan, status) values ($1, $2, 'crawl_plus', 'active')`,
    [user.rows[0].id, `cus_${label}_${randomUUID()}`],
  )
  return { token: await testAccessToken(user.rows[0].id), chatbotId: bot.rows[0].id }
}

describe("WP-2.1 async document ingest", () => {
  it("persists a processing row and storage_key without embedding on the HTTP hop", async () => {
    const { embedTexts } = await import("../../src/services/embeddings.service.js")
    vi.mocked(embedTexts).mockClear()
    const { token, chatbotId } = await seedCrawlPlusChatbot("async-persist")

    const res = await request(app)
      .post(`/chatbots/${chatbotId}/documents`)
      .set("Authorization", `Bearer ${token}`)
      .attach("file", Buffer.from("Office hours are 9 to 5.\n"), "hours.txt")

    expect(res.status).toBe(202)
    expect(res.body.document.status).toBe("processing")
    expect(res.body.document.id).toBeTruthy()

    const { rows } = await pool!.query<{ storage_key: string; status: string }>(
      `select storage_key, status from chatbot_documents where id = $1`,
      [res.body.document.id],
    )
    expect(rows[0].status).toBe("processing")
    expect(rows[0].storage_key).toMatch(new RegExp(`^tenant/${chatbotId}/documents/${res.body.document.id}/`))
    const stored = await getDocumentObject(rows[0].storage_key)
    expect(stored.toString("utf8")).toContain("Office hours")

    expect(embedTexts).not.toHaveBeenCalled()
  })

  it("does not lose the file if the client would time out after 202", async () => {
    const { token, chatbotId } = await seedCrawlPlusChatbot("async-timeout")
    const res = await request(app)
      .post(`/chatbots/${chatbotId}/documents`)
      .set("Authorization", `Bearer ${token}`)
      .attach("file", Buffer.from("Return policy is 30 days.\n"), "returns.txt")

    expect(res.status).toBe(202)
    const { rows } = await pool!.query<{ storage_key: string }>(
      `select storage_key from chatbot_documents where id = $1`,
      [res.body.document.id],
    )
    await expect(getDocumentObject(rows[0].storage_key)).resolves.toBeInstanceOf(Buffer)
  })

  it("marks the document ready when the worker processes stored bytes", async () => {
    const { token, chatbotId } = await seedCrawlPlusChatbot("async-ready")
    const res = await request(app)
      .post(`/chatbots/${chatbotId}/documents`)
      .set("Authorization", `Bearer ${token}`)
      .attach("file", Buffer.from("Shipping is free over fifty dollars.\n"), "shipping.txt")
    expect(res.status).toBe(202)

    const { processPersistedDocument } = await import("../../src/services/documentIngestion.service.js")
    const processed = await processPersistedDocument(res.body.document.id, chatbotId)
    expect(processed.status).toBe("ready")
    expect(processed.chunkCount).toBeGreaterThan(0)

    const listed = await request(app).get(`/chatbots/${chatbotId}/documents`).set("Authorization", `Bearer ${token}`)
    expect(listed.status).toBe(200)
    expect(listed.body.documents[0].status).toBe("ready")
  })

  it("retries a failed document from storage_key", async () => {
    const { token, chatbotId } = await seedCrawlPlusChatbot("async-retry")
    const uploaded = await request(app)
      .post(`/chatbots/${chatbotId}/documents`)
      .set("Authorization", `Bearer ${token}`)
      .attach("file", Buffer.from("Warranty covers parts for one year.\n"), "warranty.txt")
    expect(uploaded.status).toBe(202)

    await pool!.query(
      `update chatbot_documents set status = 'failed', error_message = 'forced fail' where id = $1`,
      [uploaded.body.document.id],
    )

    const retry = await request(app)
      .post(`/chatbots/${chatbotId}/documents/${uploaded.body.document.id}/retry`)
      .set("Authorization", `Bearer ${token}`)
    expect(retry.status).toBe(202)
    expect(retry.body.document.status).toBe("processing")

    const { processPersistedDocument } = await import("../../src/services/documentIngestion.service.js")
    const processed = await processPersistedDocument(uploaded.body.document.id, chatbotId)
    expect(processed.status).toBe("ready")
  })
})
