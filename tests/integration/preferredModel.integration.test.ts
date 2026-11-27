import { randomUUID } from "node:crypto"
import request from "supertest"
import { describe, expect, it, vi } from "vitest"

// Capability 1 — manual model selection. This exercises the real HTTP
// route (PATCH /chatbots/:chatbotId/preferred-model), real Full-Custom
// plan gating (requireFullCustomPlan, the SAME check WooCommerce/Bookly
// connect already use), real ownership scoping, and the real end-to-end
// effect on a chat turn — matching the base spec's explicit testing
// requirements: preferred model used when available, correct fallback when
// exhausted, and the change persisting and taking effect for the next
// conversation.
//
// CS-17 (B09-018): model selection and pinning are real; only the final
// provider completion is a deterministic fake (it used to be a paid live
// call). The pinned model is decided before that call, so the assertions
// below are unchanged.
vi.mock("../../src/lib/ai.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/ai.js")>()
  const { fakeAnswerQuestion } = await import("../helpers/fakeAi.js")
  return { ...actual, answerQuestion: vi.fn(fakeAnswerQuestion), completeCheaply: vi.fn(async () => null) }
})
const { app, signupUser } = await import("../helpers.js")
const { pool } = await import("../../src/lib/db.js")
const { currentBillingPeriod } = await import("../../src/services/usage.service.js")

function authed(token: string) {
  return { Authorization: `Bearer ${token}` }
}

async function seedFullCustomChatbot(label: string) {
  const db = pool!
  const signup = await signupUser(label)
  await db.query(`insert into subscriptions (user_id, stripe_customer_id, plan, status) values ($1, $2, 'full_custom', 'active')`, [
    signup.user.id,
    `cus_${randomUUID()}`,
  ])
  const created = await request(app)
    .post("/chatbots")
    .set(authed(signup.session.access_token))
    .send({ name: "bot", sources: [{ type: "pdf", label: "a.pdf", characters: 12, content: "support info" }] })
  return { chatbotId: created.body.chatbot.id as string, accessToken: signup.session.access_token as string, userId: signup.user.id as string }
}

async function pinnedModelFor(chatbotId: string, sessionId: string): Promise<string | null> {
  const { rows } = await pool!.query<{ pinned_model: string | null }>(
    // Since CS-04 the dashboard chat stores a derived key
    // (chatSessionKey("preview", userId, sessionId) = "preview:<user>:<sid>"),
    // not the raw client session id; sessionId is a fresh UUID, so this
    // suffix match is unique.
    "select pinned_model from conversations where chatbot_id = $1 and session_id like 'preview:%:' || $2",
    [chatbotId, sessionId],
  )
  return rows[0]?.pinned_model ?? null
}

describe("PATCH /chatbots/:chatbotId/preferred-model — plan gating and ownership", () => {
  it("is rejected (402) for a chatbot on the default free-trial plan, and the value is never persisted", async () => {
    const signup = await signupUser("preferred-model-free")
    const created = await request(app)
      .post("/chatbots")
      .set(authed(signup.session.access_token))
      .send({ name: "bot", sources: [{ type: "pdf", label: "a.pdf", characters: 5, content: "x" }] })
    const chatbotId = created.body.chatbot.id as string

    const res = await request(app)
      .patch(`/chatbots/${chatbotId}/preferred-model`)
      .set(authed(signup.session.access_token))
      .send({ preferredModel: "gemini" })
    expect(res.status).toBe(402)

    const status = await request(app).get(`/chatbots/${chatbotId}`).set(authed(signup.session.access_token))
    expect(status.body.chatbot.preferredModel).toBeUndefined()
  })

  it("a Full Custom owner can set each model, persists across a re-fetch, and 'auto' reverts it to unset", async () => {
    const { chatbotId, accessToken } = await seedFullCustomChatbot("preferred-model-owner")

    for (const model of ["anthropic", "openai", "gemini"] as const) {
      const res = await request(app).patch(`/chatbots/${chatbotId}/preferred-model`).set(authed(accessToken)).send({ preferredModel: model })
      expect(res.status).toBe(200)
      expect(res.body.chatbot.preferredModel).toBe(model)

      const refetched = await request(app).get(`/chatbots/${chatbotId}`).set(authed(accessToken))
      expect(refetched.body.chatbot.preferredModel).toBe(model)
    }

    const reset = await request(app).patch(`/chatbots/${chatbotId}/preferred-model`).set(authed(accessToken)).send({ preferredModel: "auto" })
    expect(reset.status).toBe(200)
    expect(reset.body.chatbot.preferredModel).toBeUndefined()
  })

  it("rejects a value outside the known model keys", async () => {
    const { chatbotId, accessToken } = await seedFullCustomChatbot("preferred-model-invalid")
    const res = await request(app).patch(`/chatbots/${chatbotId}/preferred-model`).set(authed(accessToken)).send({ preferredModel: "not-a-real-model" })
    expect(res.status).toBe(400)
  })

  it("an owner cannot set another owner's chatbot's preferred model, even with its real, known-valid id", async () => {
    const ownerA = await seedFullCustomChatbot("preferred-model-tenant-a")
    const ownerB = await seedFullCustomChatbot("preferred-model-tenant-b")

    const res = await request(app)
      .patch(`/chatbots/${ownerB.chatbotId}/preferred-model`)
      .set(authed(ownerA.accessToken))
      .send({ preferredModel: "gemini" })
    expect(res.status).toBe(404)

    // ownerB's own chatbot is untouched by ownerA's attempt.
    const stillAuto = await request(app).get(`/chatbots/${ownerB.chatbotId}`).set(authed(ownerB.accessToken))
    expect(stillAuto.body.chatbot.preferredModel).toBeUndefined()
  })
})

describe("Manual model selection — real end-to-end effect on a chat turn (provider completion faked)", () => {
  it("a preferred model with no usage this period is genuinely selected and pinned for a brand-new conversation", async () => {
    const { chatbotId, accessToken } = await seedFullCustomChatbot("preferred-model-e2e-available")
    await request(app).patch(`/chatbots/${chatbotId}/preferred-model`).set(authed(accessToken)).send({ preferredModel: "anthropic" })

    const sessionId = `session-${randomUUID()}`
    const chat = await request(app)
      .post(`/chatbots/${chatbotId}/chat`)
      .set(authed(accessToken))
      .send({ question: "hi", history: [], sessionId })
    expect(chat.status).toBe(200)

    expect(await pinnedModelFor(chatbotId, sessionId)).toBe("anthropic")
  })

  it("a preferred model already exhausted this billing period correctly falls back to the auto chain instead of being pinned", async () => {
    const { chatbotId, accessToken } = await seedFullCustomChatbot("preferred-model-e2e-exhausted")

    // Real exhaustion, not a mock: an estimated_cost far above the
    // Full Custom per-model cap for gemini, this exact billing period —
    // the same chatbot_usage row shape recordUsage itself writes.
    await pool!.query(
      `insert into chatbot_usage (chatbot_id, billing_period, model, input_tokens, output_tokens, estimated_cost)
       values ($1, $2, 'gemini', 0, 0, 999999) on conflict (chatbot_id, billing_period, model) do update set estimated_cost = excluded.estimated_cost`,
      [chatbotId, currentBillingPeriod()],
    )
    await request(app).patch(`/chatbots/${chatbotId}/preferred-model`).set(authed(accessToken)).send({ preferredModel: "gemini" })

    const sessionId = `session-${randomUUID()}`
    const chat = await request(app)
      .post(`/chatbots/${chatbotId}/chat`)
      .set(authed(accessToken))
      .send({ question: "hi", history: [], sessionId })
    expect(chat.status).toBe(200)

    const pinned = await pinnedModelFor(chatbotId, sessionId)
    expect(pinned).not.toBe("gemini")
    expect(pinned).not.toBeNull()
  })

  it("a preference change persists and takes effect for the NEXT conversation — an already-pinned conversation keeps its own model unchanged, matching PHASE C's existing 'decided once per conversation' behavior", async () => {
    const { chatbotId, accessToken } = await seedFullCustomChatbot("preferred-model-e2e-persists")

    await request(app).patch(`/chatbots/${chatbotId}/preferred-model`).set(authed(accessToken)).send({ preferredModel: "anthropic" })
    const firstSession = `session-${randomUUID()}`
    await request(app).post(`/chatbots/${chatbotId}/chat`).set(authed(accessToken)).send({ question: "hi", history: [], sessionId: firstSession })
    expect(await pinnedModelFor(chatbotId, firstSession)).toBe("anthropic")

    // Dashboard change to a different model, same chatbot.
    await request(app).patch(`/chatbots/${chatbotId}/preferred-model`).set(authed(accessToken)).send({ preferredModel: "openai" })

    // The FIRST conversation's own pin is untouched by the change...
    await request(app).post(`/chatbots/${chatbotId}/chat`).set(authed(accessToken)).send({ question: "still there?", history: [], sessionId: firstSession })
    expect(await pinnedModelFor(chatbotId, firstSession)).toBe("anthropic")

    // ...but a NEW conversation picks up the change immediately. A
    // DIFFERENT question than the earlier calls, deliberately — the
    // chatbot+question answer cache (see answerChatbotQuestion.ts) is
    // keyed by question text, not by session, and a cache hit skips model
    // selection entirely; reusing "hi" here would silently test the
    // cache instead of this capability.
    const secondSession = `session-${randomUUID()}`
    await request(app)
      .post(`/chatbots/${chatbotId}/chat`)
      .set(authed(accessToken))
      .send({ question: "what support info do you have?", history: [], sessionId: secondSession })
    expect(await pinnedModelFor(chatbotId, secondSession)).toBe("openai")
  })
})
