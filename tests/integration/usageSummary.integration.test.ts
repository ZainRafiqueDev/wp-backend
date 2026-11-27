import { randomUUID } from "node:crypto"
import request from "supertest"
import { describe, expect, it } from "vitest"

// Capability 2 — per-conversation usage view. A second lens on EXISTING
// data (chatbot_usage, conversations) — this suite seeds both directly
// (the same tables recordUsage/loadConversationContext already write to)
// and checks GET /chatbots/:chatbotId/usage reports them correctly,
// cross-checked against each other for consistency, exactly as the base
// spec's testing requirement asks. No cap-enforcement path is touched by
// any of this — isModelQuotaAvailable/isOverCostCap are never called here.
const { app, signupUser } = await import("../helpers.js")
const { pool } = await import("../../src/lib/db.js")
const { currentBillingPeriod } = await import("../../src/services/usage.service.js")

function authed(token: string) {
  return { Authorization: `Bearer ${token}` }
}

async function seedChatbot(label: string) {
  const signup = await signupUser(label)
  const created = await request(app)
    .post("/chatbots")
    .set(authed(signup.session.access_token))
    .send({ name: "bot", sources: [{ type: "pdf", label: "a.pdf", characters: 5, content: "x" }] })
  return { chatbotId: created.body.chatbot.id as string, accessToken: signup.session.access_token as string }
}

async function seedConversation(chatbotId: string, sessionId: string) {
  await pool!.query(
    `insert into conversations (chatbot_id, session_id) values ($1, $2) on conflict (chatbot_id, session_id) do nothing`,
    [chatbotId, sessionId],
  )
}

async function seedUsage(chatbotId: string, period: string, model: string, inputTokens: number, outputTokens: number, costUsd: number) {
  await pool!.query(
    `insert into chatbot_usage (chatbot_id, billing_period, model, input_tokens, output_tokens, estimated_cost)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (chatbot_id, billing_period, model) do update set
       input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens, estimated_cost = excluded.estimated_cost`,
    [chatbotId, period, model, inputTokens, outputTokens, costUsd],
  )
}

describe("GET /chatbots/:chatbotId/usage — read-only reporting, no new write path", () => {
  it("a chatbot with zero activity reports all-zero totals and a zero conversation count, not an error", async () => {
    const { chatbotId, accessToken } = await seedChatbot("usage-empty")
    const res = await request(app).get(`/chatbots/${chatbotId}/usage`).set(authed(accessToken))
    expect(res.status).toBe(200)
    expect(res.body.usage).toMatchObject({
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCostUsd: 0,
      conversationCount: 0,
      byModel: [],
    })
  })

  it("correctly counts distinct conversations against real seeded data, cross-checked against token totals for consistency", async () => {
    const { chatbotId, accessToken } = await seedChatbot("usage-real")
    const period = currentBillingPeriod()

    // 3 distinct conversations this period (a real customer scenario: the
    // same chatbot, three separate widget sessions).
    await seedConversation(chatbotId, `session-${randomUUID()}`)
    await seedConversation(chatbotId, `session-${randomUUID()}`)
    await seedConversation(chatbotId, `session-${randomUUID()}`)

    // Real per-model token/cost rows, the SAME shape recordUsage itself
    // writes — two different models, summed on the way out.
    await seedUsage(chatbotId, period, "anthropic", 1000, 500, 0.42)
    await seedUsage(chatbotId, period, "openai", 300, 150, 0.08)

    const res = await request(app).get(`/chatbots/${chatbotId}/usage`).set(authed(accessToken))
    expect(res.status).toBe(200)
    const usage = res.body.usage

    expect(usage.conversationCount).toBe(3)
    expect(usage.totalInputTokens).toBe(1300)
    expect(usage.totalOutputTokens).toBe(650)
    expect(usage.totalCostUsd).toBeCloseTo(0.5, 6)
    // Cross-check: the per-model breakdown sums to exactly the totals.
    const summedInput = usage.byModel.reduce((sum: number, m: { inputTokens: number }) => sum + m.inputTokens, 0)
    const summedOutput = usage.byModel.reduce((sum: number, m: { outputTokens: number }) => sum + m.outputTokens, 0)
    const summedCost = usage.byModel.reduce((sum: number, m: { costUsd: number }) => sum + m.costUsd, 0)
    expect(summedInput).toBe(usage.totalInputTokens)
    expect(summedOutput).toBe(usage.totalOutputTokens)
    expect(summedCost).toBeCloseTo(usage.totalCostUsd, 6)
  })

  it("only counts conversations/usage for the requested chatbot, never a sibling chatbot's activity", async () => {
    const a = await seedChatbot("usage-isolation-a")
    const b = await seedChatbot("usage-isolation-b")
    const period = currentBillingPeriod()

    await seedConversation(a.chatbotId, `session-${randomUUID()}`)
    await seedConversation(b.chatbotId, `session-${randomUUID()}`)
    await seedConversation(b.chatbotId, `session-${randomUUID()}`)
    await seedUsage(a.chatbotId, period, "anthropic", 100, 50, 0.01)
    await seedUsage(b.chatbotId, period, "anthropic", 999, 999, 9.99)

    const resA = await request(app).get(`/chatbots/${a.chatbotId}/usage`).set(authed(a.accessToken))
    expect(resA.body.usage.conversationCount).toBe(1)
    expect(resA.body.usage.totalInputTokens).toBe(100)

    const resB = await request(app).get(`/chatbots/${b.chatbotId}/usage`).set(authed(b.accessToken))
    expect(resB.body.usage.conversationCount).toBe(2)
    expect(resB.body.usage.totalInputTokens).toBe(999)
  })

  it("an owner cannot read another owner's chatbot's usage, even with its real, known-valid id", async () => {
    const ownerA = await seedChatbot("usage-cross-tenant-a")
    const ownerB = await seedChatbot("usage-cross-tenant-b")
    await seedUsage(ownerB.chatbotId, currentBillingPeriod(), "anthropic", 500, 500, 1.5)

    const res = await request(app).get(`/chatbots/${ownerB.chatbotId}/usage`).set(authed(ownerA.accessToken))
    expect(res.status).toBe(404)
  })

  it("a conversation seeded in a DIFFERENT billing period is excluded from the current period's count", async () => {
    const { chatbotId, accessToken } = await seedChatbot("usage-period-boundary")
    await seedConversation(chatbotId, `session-${randomUUID()}`) // this period

    // A conversation whose created_at falls in a past period.
    await pool!.query(
      `insert into conversations (chatbot_id, session_id, created_at) values ($1, $2, now() - interval '2 years')`,
      [chatbotId, `session-${randomUUID()}`],
    )

    const res = await request(app).get(`/chatbots/${chatbotId}/usage`).set(authed(accessToken))
    expect(res.body.usage.conversationCount).toBe(1)
  })

  it("an explicit ?period= looks back at a past month without touching the current one", async () => {
    const { chatbotId, accessToken } = await seedChatbot("usage-explicit-period")
    await seedUsage(chatbotId, "2020-01", "anthropic", 42, 24, 0.05)
    await seedConversation(chatbotId, `session-${randomUUID()}`) // current period, must not leak into 2020-01's result

    const res = await request(app).get(`/chatbots/${chatbotId}/usage?period=2020-01`).set(authed(accessToken))
    expect(res.body.usage.billingPeriod).toBe("2020-01")
    expect(res.body.usage.totalInputTokens).toBe(42)
    expect(res.body.usage.conversationCount).toBe(0)
  })

  it("requires authentication", async () => {
    const res = await request(app).get("/chatbots/00000000-0000-0000-0000-000000000000/usage")
    expect(res.status).toBe(401)
  })

  it("labels the month window as credits and day/week as burst control", async () => {
    const { chatbotId, accessToken } = await seedChatbot("usage-window-labels")
    const res = await request(app).get(`/chatbots/${chatbotId}/usage`).set(authed(accessToken))
    expect(res.status).toBe(200)
    expect(res.body.windows.month).toMatchObject({
      kind: "credits",
      customerFacingCredits: true,
      label: "Monthly AI credits",
    })
    expect(res.body.windows.day).toMatchObject({ kind: "burst", customerFacingCredits: false })
    expect(res.body.windows.week).toMatchObject({ kind: "burst", customerFacingCredits: false })
  })
})
