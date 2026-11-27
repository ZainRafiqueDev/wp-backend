import { randomUUID } from "node:crypto"
import request from "supertest"
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"

// VER-01 / B08-001 — a client-chosen X-Request-Id used to become the AI
// cost-reservation idempotency key. Replaying an id whose reservation was
// already reconciled returned ok with a no-charge commit and the provider
// was still called: unlimited unbilled AI calls past every cap.

// Model selection is mocked out so routing falls back to lib/ai.ts's fixed
// provider order (same as public.integration.test.ts).
vi.mock("../../src/services/modelSelection.service.js", () => ({
  selectModelForNewConversation: vi.fn(async () => null),
  selectModelForConversation: vi.fn(async () => null),
}))

// Retrieval embeddings are not what this test is about; returning no vector
// makes retrieval fall back to keyword search without any provider call.
vi.mock("../../src/services/embeddings.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/embeddings.service.js")>()
  return {
    ...actual,
    embedText: vi.fn(async () => null),
    embedTexts: vi.fn(async (texts: string[]) => texts.map(() => null)),
  }
})

// Auxiliary cheap completions (query rewrite, rerank) are stubbed so the
// provider calls counted below are exactly the reserved answer calls.
vi.mock("../../src/lib/ai.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/ai.js")>()
  return { ...actual, completeCheaply: vi.fn(async () => null) }
})

// Provider circuit-breaker state lives in shared Redis (other suites trip
// it); keep every circuit closed so routing here is deterministic.
vi.mock("../../src/lib/circuitBreaker.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/circuitBreaker.js")>()
  return {
    ...actual,
    isCircuitOpen: vi.fn(async () => false),
    recordCircuitSuccess: vi.fn(async () => undefined),
    recordCircuitFailure: vi.fn(async () => undefined),
  }
})

// Every AI provider is mocked through fetch; nothing in this file reaches
// the network. Each provider reply reports token usage costing
// `providerCallCostUsd`, so the test controls what a call is charged.
let providerCallCostUsd = 0.001
const providerCalls: string[] = []

const { estimateCostUsd } = await import("../../src/lib/aiPricing.js")
const { env } = await import("../../src/env.js")

function inputTokensCosting(model: string, usd: number): number {
  const perToken = estimateCostUsd(model, 1_000_000, 0) / 1_000_000
  return Math.ceil(usd / perToken)
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })
}

const realFetch = globalThis.fetch
vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
  if (url.startsWith("https://api.anthropic.com/v1/messages")) {
    providerCalls.push("anthropic")
    return json({
      content: [{ type: "text", text: "Our support email is help@example.com." }],
      usage: { input_tokens: inputTokensCosting(env.anthropicModel, providerCallCostUsd), output_tokens: 0 },
    })
  }
  if (url.startsWith("https://api.openai.com/v1/chat/completions")) {
    providerCalls.push("openai")
    return json({
      choices: [{ message: { role: "assistant", content: "Our support email is help@example.com." } }],
      usage: { prompt_tokens: inputTokensCosting(env.openaiModel, providerCallCostUsd), completion_tokens: 0 },
    })
  }
  if (url.startsWith("https://generativelanguage.googleapis.com/")) {
    providerCalls.push("gemini")
    return json({
      candidates: [{ content: { parts: [{ text: "Our support email is help@example.com." }] } }],
      usageMetadata: { promptTokenCount: inputTokensCosting(env.geminiModel, providerCallCostUsd), candidatesTokenCount: 0 },
    })
  }
  // Anything else (embeddings, email, ...) is refused locally — no network.
  return new Response("blocked in test", { status: 503 })
})

afterAll(() => {
  vi.stubGlobal("fetch", realFetch)
})

const { app, createReadyChatbotWithDomain } = await import("../helpers.js")
const { pool } = await import("../../src/lib/db.js")
const { runWithSystemContext } = await import("../../src/lib/tenantContext.js")

// An active paid plan whose per-model, account-wide day/week/month caps are
// all `capUsd` (the subscription override columns), so the test owns the cap.
async function readyChatbotWithCap(label: string, capUsd: number) {
  const bot = await createReadyChatbotWithDomain(label, `${label}-${randomUUID().slice(0, 8)}.test`)
  await pool!.query(
    `insert into subscriptions (user_id, stripe_customer_id, plan, status, custom_daily_cap_usd, custom_weekly_cap_usd, custom_monthly_cap_usd)
     values ($1, $2, 'crawl_plus', 'active', $3, $3, $3)`,
    [bot.userId, `cus_${randomUUID()}`, capUsd],
  )
  return bot
}

async function tenantReservations(chatbotId: string) {
  const { rows } = await runWithSystemContext(() =>
    pool!.query<{ request_id: string; status: string; actual_micro_usd: string | null }>(
      "select request_id, status, actual_micro_usd from reservations where chatbot_id = $1 and scope = 'tenant' order by created_at",
      [chatbotId],
    ),
  )
  return rows
}

function charged(rows: Awaited<ReturnType<typeof tenantReservations>>) {
  return rows.filter((r) => r.status === "reconciled" && BigInt(r.actual_micro_usd ?? "0") > 0n)
}

function chat(chatbotId: string, domain: string, clientRequestId: string, message: string) {
  return request(app)
    .post(`/public/chatbots/${chatbotId}/chat`)
    .set({ "X-Widget-Origin": `https://${domain}`, Referer: `https://${domain}/page`, "X-Request-Id": clientRequestId })
    .send({ message, history: [] })
}

beforeEach(() => {
  providerCalls.length = 0
})

describe("public chat — replaying X-Request-Id never yields a free AI call (VER-01)", () => {
  it("two requests with the same X-Request-Id each get their own fresh, charged reservation", async () => {
    providerCallCostUsd = 0.001
    const { chatbotId, domain } = await readyChatbotWithCap("reqid-replay-fresh", 5)
    const clientId = `replay-${randomUUID()}`

    const first = await chat(chatbotId, domain, clientId, "What is your support email address?")
    const second = await chat(chatbotId, domain, clientId, "How can I contact your support team?")
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)

    // The response id is server-generated, not the client's echo.
    expect(first.headers["x-request-id"]).not.toBe(clientId)
    expect(first.headers["x-request-id"]).not.toBe(second.headers["x-request-id"])

    expect(providerCalls.length).toBe(2)
    const rows = await tenantReservations(chatbotId)
    // Every provider call was charged against its own reservation. (A
    // provider attempt that fails before answering reconciles at $0, so
    // only charged rows are counted.)
    expect(charged(rows).length).toBe(providerCalls.length)
    expect(new Set(charged(rows).map((r) => r.request_id)).size).toBe(providerCalls.length)
    // The client's header is never part of a reservation key.
    expect(rows.some((r) => r.request_id.includes(clientId))).toBe(false)
  })

  it("with a cap that allows one call, a replay of the same X-Request-Id is denied, not served free", async () => {
    // Cap $0.06: the first reservation fits (each is capped at
    // PER_CALL_COST_RESERVATION_USD, $0.05 by default), and its actual
    // charge of $0.07 then exhausts the account-wide cap.
    providerCallCostUsd = 0.07
    const { chatbotId, domain } = await readyChatbotWithCap("reqid-replay-cap", 0.06)
    const clientId = `replay-${randomUUID()}`

    const first = await chat(chatbotId, domain, clientId, "What is your support email address?")
    expect(first.status).toBe(200)
    expect(providerCalls.length).toBe(1)

    const second = await chat(chatbotId, domain, clientId, "How can I contact your support team?")
    expect(second.status).toBe(200)
    // Old code: the replayed id hit the "already reconciled" branch, got
    // ok: true, and the provider was called a second time for free.
    expect(providerCalls.length).toBe(1)

    const rows = await tenantReservations(chatbotId)
    expect(charged(rows).length).toBe(1)
  })
})

describe("reserveModelCostSlot — a duplicate reservation key never authorizes a call (VER-01)", () => {
  it("denies a replay of a key whose reservation is already reconciled, or still held", async () => {
    const { reserveModelCostSlot } = await import("../../src/services/usage.service.js")
    const { getEntitlementForChatbot } = await import("../../src/services/billing.service.js")
    const { chatbotId } = await readyChatbotWithCap("reqid-replay-direct", 5)
    const entitlement = await getEntitlementForChatbot(chatbotId)

    const reconciledKey = randomUUID()
    const first = await reserveModelCostSlot(chatbotId, "openai", entitlement, reconciledKey, 0.001)
    expect(first.ok).toBe(true)
    if (first.ok) await first.commit(0.001)
    // Old code: ok: true with a no-charge commit — a free provider call.
    const replay = await reserveModelCostSlot(chatbotId, "openai", entitlement, reconciledKey, 0.001)
    expect(replay.ok).toBe(false)

    const heldKey = randomUUID()
    const held = await reserveModelCostSlot(chatbotId, "openai", entitlement, heldKey, 0.001)
    expect(held.ok).toBe(true)
    const heldReplay = await reserveModelCostSlot(chatbotId, "openai", entitlement, heldKey, 0.001)
    expect(heldReplay.ok).toBe(false)
    if (held.ok) await held.commit(0)

    // A key already used by ANOTHER chatbot is also denied, not treated as
    // "no idempotency guard".
    const other = await readyChatbotWithCap("reqid-replay-direct-other", 5)
    const otherEntitlement = await getEntitlementForChatbot(other.chatbotId)
    const crossTenant = await reserveModelCostSlot(other.chatbotId, "openai", otherEntitlement, reconciledKey, 0.001)
    expect(crossTenant.ok).toBe(false)
  })
})
