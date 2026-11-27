import { randomUUID } from "node:crypto"
import request from "supertest"
import { describe, expect, it, vi } from "vitest"

// CS-17 (B09-001): these tests used to send real chat turns to paid AI
// providers and regex-match the model's wording. The provider call is now a
// deterministic fake (tests/helpers/fakeAi.ts) and the tests assert on what
// the model is GIVEN — the attachment notice and the cache bypass — which is
// the product's actual guarantee.
vi.mock("../../src/lib/ai.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/ai.js")>()
  const { fakeAnswerQuestion } = await import("../helpers/fakeAi.js")
  return { ...actual, answerQuestion: vi.fn(fakeAnswerQuestion), completeCheaply: vi.fn(async () => null) }
})

import { EICAR_TEST_SIGNATURE } from "../../src/services/malwareScan.service.js"
import { pool } from "../../src/lib/db.js"
import { issueWidgetSession } from "../../src/services/customerSession.service.js"
import { answerQuestion } from "../../src/lib/ai.js"
import { app, createReadyChatbotWithDomain } from "../helpers.js"

// CS-04: uploads bind to a conversation through the server-issued widget
// session token, never a client-chosen id. Each test label maps to one
// issued session so "same session" / "different session" keep their meaning.
const issuedSessions = new Map<string, string>()
function sessionTokenFor(chatbotId: string, label: string): string {
  const key = `${chatbotId}:${label}`
  if (!issuedSessions.has(key)) issuedSessions.set(key, issueWidgetSession(chatbotId).sessionToken)
  return issuedSessions.get(key) as string
}

const DOMAIN_ORIGIN = (domain: string) => `https://${domain}`

const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from([1, 2, 3, 4, 5]),
])

async function makeCrawlPlusChatbot(label: string) {
  const domain = `${label}.example`
  const seeded = await createReadyChatbotWithDomain(label, domain)
  await pool!.query(
    `insert into subscriptions (user_id, stripe_customer_id, plan, status) values ($1, $2, 'crawl_plus', 'active')`,
    [seeded.userId, `cus_${label}_${randomUUID()}`],
  )
  return { ...seeded, domain }
}

async function uploadPng(chatbotId: string, domain: string, sessionId: string, fileName = "photo.png") {
  return request(app)
    .post(`/public/chatbots/${chatbotId}/attachments`)
    .set("X-Widget-Origin", DOMAIN_ORIGIN(domain))
    .field("sessionToken", sessionTokenFor(chatbotId, sessionId))
    .attach("file", PNG_BYTES, fileName)
}

describe("Phase 3: managed chat attachments", () => {
  it("accepts a valid PNG, marks it clean, records a fixed ack message, and increments the account's storage counter", async () => {
    const { chatbotId, domain } = await makeCrawlPlusChatbot("attach-happy")
    const res = await uploadPng(chatbotId, domain, `session-${randomUUID()}`)

    expect(res.status).toBe(201)
    expect(res.body.attachment).toMatchObject({ status: "clean", contentType: "image/png", fileSize: PNG_BYTES.length })

    const { rows: msgRows } = await pool!.query<{ role: string; content: string }>(
      `select role, content from messages where conversation_id = $1 order by created_at asc`,
      [res.body.attachment.conversationId],
    )
    expect(msgRows.some((m) => m.role === "assistant" && m.content.includes("Thanks, your file was received"))).toBe(true)
    // Must never claim to have read the file.
    expect(msgRows.every((m) => !/read|review the contents|looked at your file/i.test(m.content) || m.role === "user")).toBe(true)

    const { rows: ownerRows } = await pool!.query<{ user_id: string }>(`select user_id from chatbots where id = $1`, [chatbotId])
    const { rows: usageRows } = await pool!.query<{ bytes_used: string }>(
      `select bytes_used from attachment_storage_usage where owner_user_id = $1`,
      [ownerRows[0].user_id],
    )
    expect(Number(usageRows[0].bytes_used)).toBe(PNG_BYTES.length)
  })

  it("rejects attachments on the Free plan with 402", async () => {
    const seeded = await createReadyChatbotWithDomain("attach-free", "attach-free.example")
    const res = await request(app)
      .post(`/public/chatbots/${seeded.chatbotId}/attachments`)
      .set("X-Widget-Origin", "https://attach-free.example")
      .field("sessionId", `session-${randomUUID()}`)
      .attach("file", PNG_BYTES, "photo.png")
    expect(res.status).toBe(402)
  })

  it("rejects a file over the plan's per-file limit with 413", async () => {
    const { chatbotId, domain } = await makeCrawlPlusChatbot("attach-toolarge")
    const oversized = Buffer.concat([PNG_BYTES, Buffer.alloc(10 * 1024 * 1024, 1)])
    const res = await request(app)
      .post(`/public/chatbots/${chatbotId}/attachments`)
      .set("X-Widget-Origin", DOMAIN_ORIGIN(domain))
      .field("sessionId", `session-${randomUUID()}`)
      .attach("file", oversized, "big.png")
    expect(res.status).toBe(413)
  })

  it("rejects content that doesn't match any allowed type's real signature, regardless of claimed filename", async () => {
    const { chatbotId, domain } = await makeCrawlPlusChatbot("attach-badtype")
    const peHeader = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00, 0xff, 0xff])
    const res = await request(app)
      .post(`/public/chatbots/${chatbotId}/attachments`)
      .set("X-Widget-Origin", DOMAIN_ORIGIN(domain))
      .field("sessionId", `session-${randomUUID()}`)
      .attach("file", peHeader, "totally-a-photo.png")
    expect(res.status).toBe(400)
    expect(res.body.code).toBe("UNSUPPORTED_FILE_TYPE")
  })

  it("denies a malware-flagged file (fail-closed), never counts its storage, and never serves it", async () => {
    const { chatbotId, domain } = await makeCrawlPlusChatbot("attach-malware")
    const infected = Buffer.from(EICAR_TEST_SIGNATURE, "ascii")
    const res = await request(app)
      .post(`/public/chatbots/${chatbotId}/attachments`)
      .set("X-Widget-Origin", DOMAIN_ORIGIN(domain))
      .field("sessionToken", sessionTokenFor(chatbotId, `session-${randomUUID()}`))
      .attach("file", infected, "note.txt")
    expect(res.status).toBe(409)
    expect(res.body.code).toBe("ATTACHMENT_DENIED")

    const { rows } = await pool!.query(`select count(*)::text as n from chatbot_attachments where chatbot_id = $1`, [chatbotId])
    expect(Number(rows[0].n)).toBe(0)

    const { rows: userRows } = await pool!.query(`select user_id from chatbots where id = $1`, [chatbotId])
    const { rows: usageRows } = await pool!.query<{ bytes_used: string }>(
      `select bytes_used from attachment_storage_usage where owner_user_id = $1`,
      [userRows[0].user_id],
    )
    expect(Number(usageRows[0]?.bytes_used ?? 0)).toBe(0)
  })

  it("enforces the 200MB-equivalent per-account storage pool atomically, shared across the owner's chatbots", async () => {
    const { chatbotId, userId, domain } = await makeCrawlPlusChatbot("attach-storage")
    // Pre-fill the account's counter to just under the Crawl Plus cap
    // (200MB) so one more small upload tips it over.
    await pool!.query(
      `insert into attachment_storage_usage (owner_user_id, bytes_used) values ($1, $2)
       on conflict (owner_user_id) do update set bytes_used = excluded.bytes_used`,
      [userId, 200 * 1024 * 1024 - 2],
    )

    const res = await uploadPng(chatbotId, domain, `session-${randomUUID()}`)
    expect(res.status).toBe(409)
    expect(res.body.code).toBe("ATTACHMENT_STORAGE_LIMIT_REACHED")
  })

  it("enforces the 10-per-conversation cap", async () => {
    const { chatbotId, domain } = await makeCrawlPlusChatbot("attach-convcap")
    const sessionId = `session-${randomUUID()}`

    let conversationId = ""
    for (let i = 0; i < 10; i++) {
      const res = await uploadPng(chatbotId, domain, sessionId, `photo-${i}.png`)
      expect(res.status).toBe(201)
      conversationId = res.body.attachment.conversationId
    }

    const eleventh = await uploadPng(chatbotId, domain, sessionId, "photo-11.png")
    expect(eleventh.status).toBe(409)
    expect(eleventh.body.code).toBe("ATTACHMENT_CONVERSATION_LIMIT_REACHED")

    const { rows } = await pool!.query(`select count(*)::text as n from chatbot_attachments where conversation_id = $1`, [conversationId])
    expect(Number(rows[0].n)).toBe(10)
  })

  it("enforces the per-IP daily cap (test override: 15/day), keyed separately from the per-conversation cap", async () => {
    const { chatbotId, domain } = await makeCrawlPlusChatbot("attach-ipcap")
    // Each upload goes to its own conversation so only the IP-daily limiter
    // (not the per-conversation count) is what rejects the final one.
    for (let i = 0; i < 15; i++) {
      const res = await uploadPng(chatbotId, domain, `session-${randomUUID()}`, `photo-${i}.png`)
      expect(res.status).toBe(201)
    }
    const next = await uploadPng(chatbotId, domain, `session-${randomUUID()}`, "photo-16.png")
    expect(next.status).toBe(429)
  })

  it("Viewer+ dashboard: lists clean attachments and streams a download with the right headers", async () => {
    const { chatbotId, domain, token } = await makeCrawlPlusChatbot("attach-download")
    const uploaded = await uploadPng(chatbotId, domain, `session-${randomUUID()}`)
    expect(uploaded.status).toBe(201)
    const attachmentId = uploaded.body.attachment.id

    const list = await request(app).get(`/chatbots/${chatbotId}/attachments`).set("Authorization", `Bearer ${token}`)
    expect(list.status).toBe(200)
    expect(list.body.attachments.some((a: { id: string }) => a.id === attachmentId)).toBe(true)

    const download = await request(app)
      .get(`/chatbots/${chatbotId}/attachments/${attachmentId}`)
      .set("Authorization", `Bearer ${token}`)
    expect(download.status).toBe(200)
    expect(download.headers["content-type"]).toContain("image/png")
    expect(download.headers["x-content-type-options"]).toBe("nosniff")
    expect(download.headers["content-disposition"]).toContain("attachment")
    expect(Buffer.compare(download.body as Buffer, PNG_BYTES)).toBe(0)
  })

  it("a denied attachment is never downloadable even if its id is guessed", async () => {
    const { chatbotId, domain, token } = await makeCrawlPlusChatbot("attach-denied-download")
    const infected = Buffer.from(EICAR_TEST_SIGNATURE, "ascii")
    await request(app)
      .post(`/public/chatbots/${chatbotId}/attachments`)
      .set("X-Widget-Origin", DOMAIN_ORIGIN(domain))
      .field("sessionId", `session-${randomUUID()}`)
      .attach("file", infected, "note.txt")

    // Nothing was persisted (denied attachments are deleted, not kept
    // quarantined) — confirms there's no id to even guess, and the list
    // stays empty.
    const list = await request(app).get(`/chatbots/${chatbotId}/attachments`).set("Authorization", `Bearer ${token}`)
    expect(list.body.attachments).toHaveLength(0)
  })

  it("the retention tick deletes expired attachments, decrements the counter, and recomputes drift", async () => {
    const { runAttachmentRetentionTick } = await import("../../src/services/chatAttachments.service.js")
    const { chatbotId, domain, userId } = await makeCrawlPlusChatbot("attach-retention")

    const uploaded = await uploadPng(chatbotId, domain, `session-${randomUUID()}`)
    expect(uploaded.status).toBe(201)
    const attachmentId = uploaded.body.attachment.id

    await pool!.query(`update chatbot_attachments set expires_at = now() - interval '1 hour' where id = $1`, [attachmentId])
    // Simulate drift: the counter says more than the (soon-to-expire) real row accounts for.
    await pool!.query(`update attachment_storage_usage set bytes_used = bytes_used + 9999 where owner_user_id = $1`, [userId])

    const result = await runAttachmentRetentionTick()
    expect(result.deleted).toBeGreaterThanOrEqual(1)

    const { rows: remaining } = await pool!.query(`select id from chatbot_attachments where id = $1`, [attachmentId])
    expect(remaining).toHaveLength(0)

    const { rows: usageRows } = await pool!.query<{ bytes_used: string }>(
      `select bytes_used from attachment_storage_usage where owner_user_id = $1`,
      [userId],
    )
    // Recompute runs against whatever's left for this owner (the expired
    // row is already gone by the time it runs) — drift is corrected to 0,
    // not to the pre-drift value.
    expect(Number(usageRows[0].bytes_used)).toBe(0)
  })

  it("a stranger cannot list or download another account's attachments", async () => {
    const { chatbotId, domain } = await makeCrawlPlusChatbot("attach-stranger-owner")
    const uploaded = await uploadPng(chatbotId, domain, `session-${randomUUID()}`)
    const attachmentId = uploaded.body.attachment.id

    const stranger = await makeCrawlPlusChatbot("attach-stranger")
    const list = await request(app).get(`/chatbots/${chatbotId}/attachments`).set("Authorization", `Bearer ${stranger.token}`)
    expect(list.status).toBe(404)

    const download = await request(app)
      .get(`/chatbots/${chatbotId}/attachments/${attachmentId}`)
      .set("Authorization", `Bearer ${stranger.token}`)
    expect(download.status).toBe(404)
  })

  // The behavioral guarantee behind decision 8 (fixed ack, never claims to
  // have read the file): once a conversation has an accepted attachment,
  // every later answer in it carries an explicit instruction
  // (answerChatbotQuestion.ts's buildAttachmentNoticePages) not to claim to
  // have seen the file's contents. Asserted on the prompt the provider gets.
  it("asking what's in an uploaded file never produces a claim that the bot read it", async () => {
    const { chatbotId, domain } = await makeCrawlPlusChatbot("attach-no-hallucinate")
    const sessionId = `session-${randomUUID()}`

    const uploaded = await uploadPng(chatbotId, domain, sessionId, "invoice.png")
    expect(uploaded.status).toBe(201)
    expect(uploaded.body.attachment.status).toBe("clean")

    const chat = await request(app)
      .post(`/public/chatbots/${chatbotId}/chat`)
      .set("X-Widget-Origin", DOMAIN_ORIGIN(domain))
      .send({ message: "What's in the file I just sent you?", history: [], sessionToken: sessionTokenFor(chatbotId, sessionId) })

    expect(chat.status).toBe(200)
    expect(chat.body.ok).not.toBe(false)
    expect(typeof chat.body.text).toBe("string")

    const calls = vi.mocked(answerQuestion).mock.calls
    expect(calls.length).toBeGreaterThan(0)
    const pages = calls[calls.length - 1][1]
    const notice = pages.find((p) => p.path === "attachment:notice")
    expect(notice, "the provider prompt must carry the attachment notice").toBeDefined()
    expect(notice!.text).toContain("invoice.png")
    expect(notice!.text).toContain("You cannot see its contents")
    expect(notice!.text).toMatch(/Never claim to have read, viewed, opened, or looked at the file/)
  })

  // The answer cache key is chatbotId + cacheVersion + normalized question
  // text — it has no conversationId. Without bypassing the cache whenever
  // a conversation has attachments, visitor A's cached answer (which may
  // reference A's filename) could be served verbatim to visitor B asking
  // the identical question text. The fake provider names A's file in A's
  // reply, so a shared cache entry would surface it in B's reply.
  it("a conversation with attachments never shares its cached answer with an attachment-less visitor asking the same question", async () => {
    const { chatbotId, domain } = await makeCrawlPlusChatbot("attach-no-cache-leak")
    const question = "did you get my file?"

    const sessionA = `session-${randomUUID()}`
    const uploaded = await uploadPng(chatbotId, domain, sessionA, "secret-dossier.png")
    expect(uploaded.status).toBe(201)
    expect(uploaded.body.attachment.status).toBe("clean")

    const chatA = await request(app)
      .post(`/public/chatbots/${chatbotId}/chat`)
      .set("X-Widget-Origin", DOMAIN_ORIGIN(domain))
      .send({ message: question, history: [], sessionToken: sessionTokenFor(chatbotId, sessionA) })
    expect(chatA.status).toBe(200)
    expect(chatA.body.text).toContain("secret-dossier.png")
    const callsBeforeB = vi.mocked(answerQuestion).mock.calls.length

    const sessionB = `session-${randomUUID()}`
    const chatB = await request(app)
      .post(`/public/chatbots/${chatbotId}/chat`)
      .set("X-Widget-Origin", DOMAIN_ORIGIN(domain))
      .send({ message: question, history: [], sessionToken: sessionTokenFor(chatbotId, sessionB) })
    expect(chatB.status).toBe(200)
    expect(typeof chatB.body.text).toBe("string")
    expect(chatB.body.text).not.toContain("secret-dossier.png")
    // Any provider call made for B's turn never carried A's attachment notice.
    const callsForB = vi.mocked(answerQuestion).mock.calls.slice(callsBeforeB)
    expect(callsForB.some(([, pages]) => pages.some((p) => p.path === "attachment:notice"))).toBe(false)
  })
})

// DOCUMENT_SCAN_PAUSE_UPLOADS is set when ClamAV is switched off
// (deploy/aws/docker-compose.no-clamav.yml). Attachments must then be off for
// every plan: hidden in the widget config and refused on upload.
describe("chat attachments while uploads are paused", () => {
  it("reports attachments disabled to the widget and refuses uploads with 503, even on Crawl Plus", async () => {
    const { env } = await import("../../src/env.js")
    const { chatbotId, domain } = await makeCrawlPlusChatbot("attach-paused")
    const before = env.documentScanPauseUploads
    env.documentScanPauseUploads = true
    try {
      const config = await request(app).get(`/public/chatbots/${chatbotId}`).set("X-Widget-Origin", DOMAIN_ORIGIN(domain))
      expect(config.status).toBe(200)
      expect(config.body.attachments.enabled).toBe(false)

      const res = await uploadPng(chatbotId, domain, `session-${randomUUID()}`)
      expect(res.status).toBe(503)
      expect(res.body.error).toBe("File attachments are turned off for now.")
    } finally {
      env.documentScanPauseUploads = before
    }

    // Back on: the same Crawl Plus chatbot accepts attachments again.
    const config = await request(app).get(`/public/chatbots/${chatbotId}`).set("X-Widget-Origin", DOMAIN_ORIGIN(domain))
    expect(config.body.attachments.enabled).toBe(true)
  })
})
