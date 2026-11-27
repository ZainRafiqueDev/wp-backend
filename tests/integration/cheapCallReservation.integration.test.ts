import { randomUUID } from "node:crypto"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// NEW-01 (Medium): completeCheaply (query rewrite, rerank, session memory,
// OKF suggestion) used to call the provider and only record usage afterwards,
// never reserving, so it ignored caps. Each attempt now reserves first and is
// never sent when the reservation is denied. Providers are a stubbed fetch.
vi.stubEnv("GEMINI_API_KEY", "test-gemini-key")
vi.stubEnv("OPENAI_API_KEY", "test-openai-key")
vi.resetModules()

const { pool } = await import("../../src/lib/db.js")
const { completeCheaply } = await import("../../src/lib/ai.js")
const { cheapCallAuthorizer } = await import("../../src/lib/cheapCallBilling.js")
const { currentBillingPeriod } = await import("../../src/services/usage.service.js")
const { signupUser } = await import("../helpers.js")

type AiUsage = import("../../src/lib/ai.js").AiUsage

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) } as Response
}

const geminiReply = jsonResponse({ candidates: [{ content: { parts: [{ text: "rewritten query" }] } }], usageMetadata: { promptTokenCount: 900, candidatesTokenCount: 20 } })
const openAiReply = jsonResponse({ choices: [{ message: { role: "assistant", content: "openai rewrite" } }], usage: { prompt_tokens: 900, completion_tokens: 20 } })

async function seedChatbot(label: string) {
  const db = pool!
  const { user } = await signupUser(`new01-cheap-${label}`)
  await db.query(`insert into subscriptions (user_id, stripe_customer_id, plan, status) values ($1, $2, 'full_custom', 'active')`, [user.id, `cus_${randomUUID()}`])
  const { rows } = await db.query("insert into chatbots (user_id, name, sources, theme, status) values ($1, 'bot', '[]', '{}', 'ready') returning id", [user.id])
  return rows[0].id as string
}

async function exhaust(chatbotId: string, models: string[]) {
  for (const model of models) {
    await pool!.query(
      `insert into chatbot_usage (chatbot_id, billing_period, model, input_tokens, output_tokens, estimated_cost) values ($1, $2, $3, 0, 0, 9999)`,
      [chatbotId, currentBillingPeriod(), model],
    )
  }
}

async function cheapReservations(chatbotId: string) {
  const { rows } = await pool!.query(
    "select request_id, model, scope, status, actual_micro_usd from reservations where chatbot_id = $1 and request_id like 'cheap:%'",
    [chatbotId],
  )
  return rows as { request_id: string; model: string; scope: string; status: string; actual_micro_usd: string | null }[]
}

describe("NEW-01: cheap auxiliary AI calls reserve before calling the provider", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn())
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("with budget, reserves under a fresh cheap:<uuid> key and reconciles to the real cost", async () => {
    const chatbotId = await seedChatbot("allowed")
    vi.mocked(fetch).mockResolvedValueOnce(geminiReply)
    const usage: AiUsage[] = []

    const text = await completeCheaply("system", "prompt", usage, cheapCallAuthorizer(chatbotId))
    expect(text).toBe("rewritten query")
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(usage).toHaveLength(1)

    const rows = await cheapReservations(chatbotId)
    expect(rows.map((r) => r.scope).sort()).toEqual(["platform", "tenant"])
    for (const r of rows) {
      expect(r.model).toBe("gemini")
      expect(r.status).toBe("reconciled")
      expect(Number(r.actual_micro_usd)).toBeGreaterThan(0)
      expect(r.request_id).toMatch(/^cheap:[0-9a-f-]{36}:(tenant|platform):gemini$/)
    }
  })

  it("with zero budget left for every provider, no provider is called", async () => {
    const chatbotId = await seedChatbot("capped")
    await exhaust(chatbotId, ["gemini", "openai"])
    vi.mocked(fetch).mockResolvedValue(geminiReply)
    const usage: AiUsage[] = []

    const text = await completeCheaply("system", "prompt", usage, cheapCallAuthorizer(chatbotId))
    expect(text).toBeNull()
    expect(fetch).not.toHaveBeenCalled()
    expect(usage).toHaveLength(0)
  })

  it("a denied provider is skipped, not called; the fallback is reserved on its own key", async () => {
    const chatbotId = await seedChatbot("gemini-capped")
    // Gemini denied (its per-model cap cannot be filled alone without also
    // filling the shared account cap), OpenAI reserved for real.
    const real = cheapCallAuthorizer(chatbotId)
    const authorize = vi.fn(async (provider: Parameters<typeof real>[0]) => (provider === "gemini" ? { ok: false as const } : real(provider)))
    vi.mocked(fetch).mockResolvedValueOnce(openAiReply)

    const text = await completeCheaply("system", "prompt", [], authorize)
    expect(text).toBe("openai rewrite")
    expect(authorize.mock.calls.map(([p]) => p)).toEqual(["gemini", "openai"])
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(String(vi.mocked(fetch).mock.calls[0][0])).toContain("api.openai.com")
    expect((await cheapReservations(chatbotId)).every((r) => r.model === "openai" && r.status === "reconciled")).toBe(true)
  })

  it("a failed provider call releases its hold (reconciled at zero)", async () => {
    const chatbotId = await seedChatbot("provider-fails")
    vi.mocked(fetch).mockRejectedValue(new Error("network down"))

    const text = await completeCheaply("system", "prompt", [], cheapCallAuthorizer(chatbotId))
    expect(text).toBeNull()
    const rows = await cheapReservations(chatbotId)
    expect(rows.length).toBeGreaterThan(0)
    for (const r of rows) {
      expect(r.status).toBe("reconciled")
      expect(Number(r.actual_micro_usd)).toBe(0)
    }
  })
})
