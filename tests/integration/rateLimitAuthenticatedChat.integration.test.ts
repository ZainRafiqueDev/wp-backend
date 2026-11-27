import request from "supertest"
import { describe, expect, it, vi } from "vitest"

import { env } from "../../src/env.js"

// This suite is about per-user rate limiting, not quota-based model
// selection (Phase C) — mocked out for the same reason as
// public.integration.test.ts/security.integration.test.ts: this test fires
// up to `authenticatedChatRateLimitPerMin + 5` (35 by default) real chat
// requests in a loop, and this sandbox's real GEMINI_API_KEY has hit its
// own provider-side quota before, adding enough real network latency per
// request to time out a loop this size. Falls back to lib/ai.ts's normal
// fixed try-order (Claude skipped, no key here -> OpenAI succeeds) same as
// before Phase C existed.
// CS-17 (B09-001): no live provider calls — deterministic fake completions.
vi.mock("../../src/lib/ai.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/ai.js")>()
  const { fakeAnswerQuestion } = await import("../helpers/fakeAi.js")
  return { ...actual, answerQuestion: vi.fn(fakeAnswerQuestion), completeCheaply: vi.fn(async () => null) }
})

vi.mock("../../src/services/modelSelection.service.js", () => ({
  selectModelForNewConversation: vi.fn(async () => null),
  selectModelForConversation: vi.fn(async () => null),
}))

const { app, signupUser } = await import("../helpers.js")

function authed(token: string) {
  return { Authorization: `Bearer ${token}` }
}

describe(`POST /chatbots/:chatbotId/chat — authenticated rate limiting (${process.env.AUTHENTICATED_CHAT_RATE_LIMIT_PER_MIN}/min in tests)`, () => {
  it("rejects requests beyond the configured per-user limit, with a Retry-After the frontend can surface", async () => {
    const { session } = await signupUser("authed-ratelimit")
    const created = await request(app)
      .post("/chatbots")
      .set(authed(session.access_token))
      .send({ name: "bot", sources: [{ type: "pdf", label: "a.pdf", characters: 5, content: "support info" }] })
    const chatbotId = created.body.chatbot.id as string

    const responses: { status: number; retryAfterHeader?: string }[] = []
    for (let i = 0; i < env.authenticatedChatRateLimitPerMin + 5; i++) {
      const res = await request(app)
        .post(`/chatbots/${chatbotId}/chat`)
        .set(authed(session.access_token))
        .send({ question: "hi", history: [] })
      responses.push({ status: res.status, retryAfterHeader: res.headers["retry-after"] })
    }

    const successCount = responses.filter((r) => r.status === 200).length
    const limited = responses.filter((r) => r.status === 429)
    expect(successCount).toBe(env.authenticatedChatRateLimitPerMin)
    expect(limited.length).toBeGreaterThan(0)
    // Every 429 carries a Retry-After header AND the same value in the JSON
    // body, so the frontend can surface "try again in Ns" without parsing headers.
    for (const r of limited) {
      expect(r.retryAfterHeader).toBeDefined()
      expect(Number(r.retryAfterHeader)).toBeGreaterThan(0)
    }
  })

  it("is scoped per user, not global — a second user isn't blocked by the first user's limit", async () => {
    const userA = await signupUser("authed-ratelimit-a")
    const userB = await signupUser("authed-ratelimit-b")
    const createdA = await request(app)
      .post("/chatbots")
      .set(authed(userA.session.access_token))
      .send({ name: "bot a", sources: [{ type: "pdf", label: "a.pdf", characters: 5, content: "x" }] })
    const chatbotIdA = createdA.body.chatbot.id as string
    const createdB = await request(app)
      .post("/chatbots")
      .set(authed(userB.session.access_token))
      .send({ name: "bot b", sources: [{ type: "pdf", label: "b.pdf", characters: 5, content: "y" }] })
    const chatbotIdB = createdB.body.chatbot.id as string

    // Exhaust user A's limit.
    for (let i = 0; i < env.authenticatedChatRateLimitPerMin; i++) {
      await request(app).post(`/chatbots/${chatbotIdA}/chat`).set(authed(userA.session.access_token)).send({ question: "hi", history: [] })
    }
    const exhausted = await request(app)
      .post(`/chatbots/${chatbotIdA}/chat`)
      .set(authed(userA.session.access_token))
      .send({ question: "hi", history: [] })
    expect(exhausted.status).toBe(429)

    // User B, who hasn't sent anything yet, is unaffected.
    const stillFine = await request(app)
      .post(`/chatbots/${chatbotIdB}/chat`)
      .set(authed(userB.session.access_token))
      .send({ question: "hi", history: [] })
    expect(stillFine.status).toBe(200)
  })

  it("requires a valid token before the rate limit even applies", async () => {
    const res = await request(app)
      .post("/chatbots/00000000-0000-0000-0000-000000000000/chat")
      .set("Authorization", "Bearer not-a-real-token")
      .send({ question: "hi", history: [] })
    expect(res.status).toBe(401)
  })
})
