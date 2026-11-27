import request from "supertest"
import { describe, expect, it, vi } from "vitest"

// This suite tests session-memory persistence and the credit-exhaustion
// save-before-block flow, not answer quality — mocked out for the same
// reason public.integration.test.ts mocks it (avoids a real, possibly
// quota-limited Gemini/OpenAI call adding latency/flakiness to a suite
// that isn't testing model output).
vi.mock("../../src/services/modelSelection.service.js", () => ({
  selectModelForNewConversation: vi.fn(async () => null),
  selectModelForConversation: vi.fn(async () => null),
}))

vi.mock("../../src/lib/ai.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/ai.js")>()
  return {
    ...actual,
    completeCheaply: vi.fn(async () => "Customer asked about the return policy; told them 30 days with a receipt. Sentiment: neutral."),
  }
})

const { app, createReadyChatbotWithDomain } = await import("../helpers.js")
const { pool } = await import("../../src/lib/db.js")
const { recordUsage } = await import("../../src/services/usage.service.js")
const { resolveCustomerIdentity } = await import("../../src/services/customerIdentity.service.js")
const { signCustomerSessionToken } = await import("../../src/lib/auth.js")
const { customerIdentifierFromEmail, getSessionSummary, updateSessionSummaryAfterTurn } = await import(
  "../../src/services/sessionMemory.service.js"
)

describe("session_summaries — master prompt cross-session memory + credit-exhaustion continuity", () => {
  it("a bare customerId (no customerToken) does not unlock or write that customer's memory", async () => {
    const { chatbotId, domain } = await createReadyChatbotWithDomain("session-memory-bare-id", `session-memory-bare-id-${Date.now()}.example`)
    const identity = await resolveCustomerIdentity(chatbotId, "bare-id-customer@example.test")
    await recordUsage(chatbotId, [{ provider: "gemini" as const, model: "gemini-flash-latest", inputTokens: 0, outputTokens: 1_900_000 }])
    await recordUsage(chatbotId, [{ provider: "openai" as const, model: "gpt-4o-mini", inputTokens: 0, outputTokens: 950_000 }])
    await recordUsage(chatbotId, [{ provider: "anthropic" as const, model: "claude-sonnet-5", inputTokens: 0, outputTokens: 40_000 }])

    const res = await request(app)
      .post(`/public/chatbots/${chatbotId}/chat`)
      .set({ "X-Widget-Origin": `https://${domain}`, Referer: `https://${domain}/page` })
      .send({ message: "Where is my order #4471?", history: [], customerId: identity.id })

    expect(res.status).toBe(200)
    // With a valid customerToken this exact turn is saved (see the next test);
    // with only the id, the customer is treated as anonymous.
    expect(await getSessionSummary(chatbotId, customerIdentifierFromEmail(chatbotId, identity.email!))).toBeNull()
  })

  it("save-before-block: monthly exhaustion persists the unanswered question and sets interrupted_by_credit_exhaustion, without ever calling an LLM", async () => {
    const { chatbotId, domain } = await createReadyChatbotWithDomain("session-memory-exhaustion", "session-memory-exhaustion.example")
    const identity = await resolveCustomerIdentity(chatbotId, "returning-customer@example.test")

    // Exhaust every allowed model's monthly cap directly (same technique as
    // usageWindows.integration.test.ts) — deterministic, no AI call needed.
    const overMonthlyUsages = [
      { provider: "gemini" as const, model: "gemini-flash-latest", inputTokens: 0, outputTokens: 1_900_000 },
      { provider: "openai" as const, model: "gpt-4o-mini", inputTokens: 0, outputTokens: 950_000 },
      { provider: "anthropic" as const, model: "claude-sonnet-5", inputTokens: 0, outputTokens: 40_000 },
    ]
    for (const usage of overMonthlyUsages) {
      await recordUsage(chatbotId, [usage])
    }

    const headers = { "X-Widget-Origin": `https://${domain}`, Referer: `https://${domain}/page` }
    const res = await request(app)
      .post(`/public/chatbots/${chatbotId}/chat`)
      .set(headers)
      .send({
        message: "Where is my order #4471?",
        history: [],
        customerToken: signCustomerSessionToken({ customerId: identity.id, chatbotId }),
      })

    expect(res.status).toBe(200)
    expect(res.body.gateReason).toBe("monthly_credits_exhausted")

    const identifier = customerIdentifierFromEmail(chatbotId, identity.email!)
    const summary = await getSessionSummary(chatbotId, identifier)
    expect(summary).not.toBeNull()
    expect(summary!.interruptedByCreditExhaustion).toBe(true)
    expect(summary!.summaryMd).toContain("#4471")

    // completeCheaply must never be called on this path — see the
    // deliberate no-LLM design note on saveInterruptedByCreditExhaustion.
    const ai = await import("../../src/lib/ai.js")
    expect(ai.completeCheaply).not.toHaveBeenCalled()
  })

  it("a normal (non-blocked) turn generates a real summary via the cheap model and clears any prior interruption", async () => {
    const { chatbotId } = await createReadyChatbotWithDomain("session-memory-turn", "session-memory-turn.example")
    const identity = await resolveCustomerIdentity(chatbotId, "another-customer@example.test")
    const identifier = customerIdentifierFromEmail(chatbotId, identity.email!)

    // Seed a prior interrupted state directly, as if a previous session had
    // been cut short by credit exhaustion.
    if (!pool) throw new Error("test requires a database pool")
    await pool.query(
      `insert into session_summaries (chatbot_id, customer_identifier, summary_md, interrupted_by_credit_exhaustion)
       values ($1, $2, 'Customer asked about pricing before running out of credits.', true)`,
      [chatbotId, identifier],
    )

    await updateSessionSummaryAfterTurn(chatbotId, identifier, "What's your return policy?", "You can return items within 30 days with a receipt.")

    const summary = await getSessionSummary(chatbotId, identifier)
    expect(summary).not.toBeNull()
    expect(summary!.interruptedByCreditExhaustion).toBe(false)
    expect(summary!.summaryMd).toContain("return policy")
  })

  it("tenant isolation: the same customer email at two different chatbots never shares a summary row", async () => {
    const { chatbotId: chatbotA } = await createReadyChatbotWithDomain("session-memory-tenant-a", "session-memory-tenant-a.example")
    const { chatbotId: chatbotB } = await createReadyChatbotWithDomain("session-memory-tenant-b", "session-memory-tenant-b.example")
    const sharedEmail = "shared-across-tenants@example.test"

    const identifierA = customerIdentifierFromEmail(chatbotA, sharedEmail)
    const identifierB = customerIdentifierFromEmail(chatbotB, sharedEmail)
    expect(identifierA).not.toBe(identifierB)

    await updateSessionSummaryAfterTurn(chatbotA, identifierA, "Question at tenant A", "Answer at tenant A")

    expect(await getSessionSummary(chatbotA, identifierA)).not.toBeNull()
    expect(await getSessionSummary(chatbotB, identifierB)).toBeNull()
    // Even a lookup that (incorrectly) reused tenant A's identifier string
    // under tenant B's chatbot_id must find nothing — chatbot_id is a real
    // column filter here, not just baked into the hash.
    expect(await getSessionSummary(chatbotB, identifierA)).toBeNull()
  })
})
