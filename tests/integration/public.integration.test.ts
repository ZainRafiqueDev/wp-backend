import request from "supertest"
import { describe, expect, it, vi } from "vitest"

import { env } from "../../src/env.js"

// This suite is about rate limiting/origin checks, not quota-based model
// selection (Phase C) — mocked out so a real, possibly-rate-limited-by-the-
// provider-itself Gemini call (this sandbox's real GEMINI_API_KEY has hit
// its own quota before) never adds real network latency to a loop that
// fires a dozen-plus requests per test, which was slow enough to time out
// the whole test. Falls back to lib/ai.ts's normal fixed try-order
// (Claude skipped, no key here -> OpenAI succeeds) same as before Phase C.
vi.mock("../../src/services/modelSelection.service.js", () => ({
  selectModelForNewConversation: vi.fn(async () => null),
  selectModelForConversation: vi.fn(async () => null),
}))
// CS-17 (B09-018): the provider completion itself is a deterministic fake
// too; these tests are about origin checks and rate limits, and used to send
// a dozen-plus real chat turns per test to a paid provider.
vi.mock("../../src/lib/ai.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/ai.js")>()
  const { fakeAnswerQuestion } = await import("../helpers/fakeAi.js")
  return { ...actual, answerQuestion: vi.fn(fakeAnswerQuestion), completeCheaply: vi.fn(async () => null) }
})

const { app, createReadyChatbotWithDomain } = await import("../helpers.js")

describe("GET /public/chatbots/:chatbotId — domain check", () => {
  it("allows a request from the configured domain", async () => {
    const { chatbotId } = await createReadyChatbotWithDomain("public-ok", "widget-ok.example")
    const res = await request(app).get(`/public/chatbots/${chatbotId}`).set("X-Widget-Origin", "https://widget-ok.example")
    expect(res.status).toBe(200)
  })

  it("allows a subdomain of the configured domain", async () => {
    const { chatbotId } = await createReadyChatbotWithDomain("public-sub", "widget-sub.example")
    const res = await request(app)
      .get(`/public/chatbots/${chatbotId}`)
      .set("X-Widget-Origin", "https://shop.widget-sub.example")
    expect(res.status).toBe(200)
  })

  it("rejects a mismatched origin with 403", async () => {
    const { chatbotId } = await createReadyChatbotWithDomain("public-mismatch", "widget-mismatch.example")
    const res = await request(app).get(`/public/chatbots/${chatbotId}`).set("X-Widget-Origin", "https://evil.example")
    expect(res.status).toBe(403)
  })

  it("rejects a missing X-Widget-Origin header", async () => {
    const { chatbotId } = await createReadyChatbotWithDomain("public-missing", "widget-missing.example")
    const res = await request(app).get(`/public/chatbots/${chatbotId}`)
    expect(res.status).toBe(403)
  })

  it("404s for a chatbot id that doesn't exist", async () => {
    const res = await request(app)
      .get("/public/chatbots/00000000-0000-0000-0000-000000000000")
      .set("X-Widget-Origin", "https://anything.example")
    expect(res.status).toBe(404)
  })
})

describe("POST /public/chatbots/:chatbotId/chat — rate limiting", () => {
  it(`rejects requests beyond the configured limit (${env.publicChatRateLimitPerMin}/min)`, async () => {
    const { chatbotId, domain } = await createReadyChatbotWithDomain("public-ratelimit", "ratelimit.example")
    const headers = { "X-Widget-Origin": `https://${domain}`, Referer: `https://${domain}/page` }

    const statuses: number[] = []
    for (let i = 0; i < env.publicChatRateLimitPerMin + 5; i++) {
      const res = await request(app).post(`/public/chatbots/${chatbotId}/chat`).set(headers).send({ message: "hi", history: [] })
      statuses.push(res.status)
    }

    const successCount = statuses.filter((s) => s === 200).length
    const limitedCount = statuses.filter((s) => s === 429).length
    expect(successCount).toBe(env.publicChatRateLimitPerMin)
    expect(limitedCount).toBeGreaterThan(0)
  })

  it("a Referer mismatch downgrades trust (stricter limit) without hard-blocking the request itself", async () => {
    const { chatbotId, domain } = await createReadyChatbotWithDomain("public-referer", "referer.example")

    const first = await request(app)
      .post(`/public/chatbots/${chatbotId}/chat`)
      .set({ "X-Widget-Origin": `https://${domain}`, Referer: "https://attacker.example/page" })
      .send({ message: "hi", history: [] })
    // Not hard-blocked — the origin header still matched, this is a trust
    // downgrade (stricter rate limit), not an authorization failure.
    expect(first.status).toBe(200)

    const statuses: number[] = []
    for (let i = 0; i < env.publicChatRateLimitStrictPerMin + 3; i++) {
      const res = await request(app)
        .post(`/public/chatbots/${chatbotId}/chat`)
        .set({ "X-Widget-Origin": `https://${domain}`, Referer: "https://attacker.example/page" })
        .send({ message: "hi", history: [] })
      statuses.push(res.status)
    }
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0)
    // Hits the strict ceiling well before the (much higher) primary one.
    expect(statuses.filter((s) => s === 200).length).toBeLessThan(env.publicChatRateLimitPerMin)
  })
})

// A non-UUID chatbotId used to reach getChatbotById, where Postgres rejects
// the uuid cast (22P02) and the request surfaced as a 500. It must now be a
// clean 400 on every public route, before any DB lookup or rate-limit key.
describe("public routes — malformed chatbotId", () => {
  const badId = "not-a-uuid"
  const cases: Array<[string, () => request.Test]> = [
    ["GET /public/chatbots/:id", () => request(app).get(`/public/chatbots/${badId}`)],
    ["POST /public/chatbots/:id/chat", () => request(app).post(`/public/chatbots/${badId}/chat`).send({ message: "hi", history: [] })],
    ["POST /public/chatbots/:id/memory/export", () => request(app).post(`/public/chatbots/${badId}/memory/export`).send({})],
    ["POST /public/chatbots/:id/memory/delete", () => request(app).post(`/public/chatbots/${badId}/memory/delete`).send({})],
    ["POST /public/chatbots/:id/attachments", () => request(app).post(`/public/chatbots/${badId}/attachments`)],
  ]

  it.each(cases)("%s returns 400", async (_label, makeRequest) => {
    const res = await makeRequest().set("X-Widget-Origin", "https://anything.example")
    expect(res.status).toBe(400)
    expect(res.body).toMatchObject({ ok: false, details: [{ path: "chatbotId" }] })
  })
})
