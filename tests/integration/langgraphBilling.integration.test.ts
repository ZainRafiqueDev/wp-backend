import { randomUUID } from "node:crypto"
import { beforeEach, describe, expect, it, vi } from "vitest"

// NEW-01: the commerce, Bookly and Bookly-admin LangGraph flows used to call
// gpt-4o-mini directly — no reservation, no recordUsage, no cap. Every graph
// LLM call now goes reserve -> call -> commit -> record, with a fresh
// server-generated key, and a denied reservation never reaches the provider.
// Also the CS-04 residual: order_status_lookup authorizes before it can
// transition the order.

const llmInvoke = vi.fn()
vi.mock("../../src/langgraph/llm.js", () => ({
  hasCommerceLlm: vi.fn(() => true),
  getCommerceLlm: vi.fn(() => ({ invoke: llmInvoke })),
}))

vi.mock("../../src/lib/woocommerce/connector.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/lib/woocommerce/connector.js")>("../../src/lib/woocommerce/connector.js")
  return { ...actual, getOrderStatus: vi.fn() }
})

const { pool } = await import("../../src/lib/db.js")
const { encryptSecret } = await import("../../src/lib/crypto.js")
const { currentBillingPeriod } = await import("../../src/services/usage.service.js")
const { tryAnswerWithCommerceGraph } = await import("../../src/langgraph/commerceEntrypoint.js")
const { tryAnswerWithBooklyGraph } = await import("../../src/langgraph/booklyEntrypoint.js")
const { buildOrderDraftNode, confirmWithCustomerNode, orderStatusLookupNode } = await import("../../src/langgraph/nodes.js")
const { classifyAdminIntentNode } = await import("../../src/langgraph/booklyAdminNodes.js")
const { LLM_BUDGET_DENIED_TEXT } = await import("../../src/langgraph/billedLlm.js")
const wooConnector = await import("../../src/lib/woocommerce/connector.js")
const { signupUser } = await import("../helpers.js")

async function seedFullCustomChatbot(label: string) {
  const db = pool!
  const { user } = await signupUser(`new01-${label}`)
  await db.query(`insert into subscriptions (user_id, stripe_customer_id, plan, status) values ($1, $2, 'full_custom', 'active')`, [user.id, `cus_${randomUUID()}`])
  const { rows } = await db.query("insert into chatbots (user_id, name, sources, theme, status) values ($1, 'bot', '[]', '{}', 'ready') returning id", [user.id])
  return rows[0].id as string
}

async function seedStore(label: string) {
  const chatbotId = await seedFullCustomChatbot(label)
  await pool!.query(
    `insert into chatbot_woocommerce_credentials (chatbot_id, store_url, consumer_key_encrypted, consumer_secret_encrypted, webhook_secret_encrypted) values ($1, 'https://shop.example.com', $2, $3, $4)`,
    [chatbotId, encryptSecret("ck"), encryptSecret("cs"), encryptSecret("wh")],
  )
  return chatbotId
}

async function seedBookly(label: string) {
  const chatbotId = await seedFullCustomChatbot(label)
  await pool!.query(
    `insert into chatbot_bookly_credentials (chatbot_id, base_url, resource_id, resource_label, api_key_encrypted) values ($1, 'https://bookly.example.com', $2, 'Resource', $3)`,
    [chatbotId, `resource-${randomUUID()}`, encryptSecret("test-bookly-api-key")],
  )
  return chatbotId
}

// Uses up this chatbot's (and its account's) whole monthly OpenAI allowance,
// while the other plan models stay free, so the answering gate still lets the
// turn in and only the per-call reservation can stop it.
async function exhaustOpenAiBudget(chatbotId: string) {
  await pool!.query(
    `insert into chatbot_usage (chatbot_id, billing_period, model, input_tokens, output_tokens, estimated_cost) values ($1, $2, 'openai', 0, 0, 9999)`,
    [chatbotId, currentBillingPeriod()],
  )
}

async function graphReservations(chatbotId: string) {
  const { rows } = await pool!.query(
    "select request_id, model, scope, status, actual_micro_usd from reservations where chatbot_id = $1 and request_id like 'langgraph:%' order by created_at",
    [chatbotId],
  )
  return rows as { request_id: string; model: string; scope: string; status: string; actual_micro_usd: string | null }[]
}

async function openAiUsage(chatbotId: string) {
  const { rows } = await pool!.query(
    "select input_tokens, output_tokens, estimated_cost from chatbot_usage where chatbot_id = $1 and billing_period = $2 and model = 'openai'",
    [chatbotId, currentBillingPeriod()],
  )
  return rows[0] as { input_tokens: number; output_tokens: number; estimated_cost: string } | undefined
}

function providerReply(content: string) {
  return { content, usage_metadata: { input_tokens: 1200, output_tokens: 3 }, response_metadata: { model_name: "gpt-4o-mini-2024-07-18" } }
}

function verifiedState(chatbotId: string, customerId: string, email: string) {
  return {
    chatbotId,
    customerId: null,
    intent: "order_status",
    candidateProducts: [],
    orderDraft: null,
    validationIssue: null,
    responseText: null,
    committedOrderId: null,
    messages: [{ role: "user" as const, content: "where is my order?" }],
    requestId: undefined,
    graphRunId: randomUUID(),
    verifiedCustomerId: customerId,
    verifiedChatbotId: chatbotId,
    verificationPrompt: null,
    verifiedEmail: email,
    verifiedAt: Date.now(),
    pendingVerificationEmail: null,
    verificationAttempts: 0,
  }
}

describe("NEW-01: LangGraph LLM calls are reserved, capped and recorded", () => {
  beforeEach(() => {
    llmInvoke.mockReset()
    vi.mocked(wooConnector.getOrderStatus).mockReset()
  })

  it("a commerce graph turn reserves under a fresh server key, reconciles, and records the usage of the model that answered", async () => {
    const chatbotId = await seedStore("commerce-billed")
    llmInvoke.mockResolvedValueOnce(providerReply("other"))

    const result = await tryAnswerWithCommerceGraph(chatbotId, randomUUID(), "hi there")
    expect(result.handled).toBe(true)
    expect(llmInvoke).toHaveBeenCalledTimes(1)

    const reservations = await graphReservations(chatbotId)
    expect(reservations.map((r) => r.scope).sort()).toEqual(["platform", "tenant"])
    for (const r of reservations) {
      expect(r.model).toBe("openai")
      expect(r.status).toBe("reconciled")
      expect(Number(r.actual_micro_usd)).toBeGreaterThan(0)
      expect(r.request_id).toMatch(/^langgraph:[0-9a-f-]{36}:(tenant|platform):openai$/)
    }

    const usage = await openAiUsage(chatbotId)
    expect(Number(usage?.input_tokens)).toBe(1200)
    expect(Number(usage?.output_tokens)).toBe(3)
    expect(Number(usage?.estimated_cost)).toBeGreaterThan(0) // priced as gpt-4o-mini, not an unknown dated id
  })

  it("every call in one turn gets its own reservation key", async () => {
    const chatbotId = await seedBookly("bookly-billed")
    llmInvoke.mockResolvedValueOnce(providerReply("availability_question"))
    llmInvoke.mockResolvedValueOnce(providerReply("null")) // extractDate -> asks for a date
    const result = await tryAnswerWithBooklyGraph(chatbotId, randomUUID(), "what's open?")
    expect(result.text).toMatch(/date/i)
    expect(llmInvoke).toHaveBeenCalledTimes(2)

    const tenantKeys = (await graphReservations(chatbotId)).filter((r) => r.scope === "tenant").map((r) => r.request_id)
    expect(tenantKeys).toHaveLength(2)
    expect(new Set(tenantKeys).size).toBe(2)
    const usage = await openAiUsage(chatbotId)
    expect(Number(usage?.input_tokens)).toBe(2400)
  })

  it("commerce: with no budget left the provider is never called and the visitor gets a polite reply", async () => {
    const chatbotId = await seedStore("commerce-capped")
    await exhaustOpenAiBudget(chatbotId)
    llmInvoke.mockResolvedValue(providerReply("product_question"))

    const result = await tryAnswerWithCommerceGraph(chatbotId, randomUUID(), "how much is the widget?")
    expect(llmInvoke).not.toHaveBeenCalled()
    expect(result).toMatchObject({ handled: true, text: LLM_BUDGET_DENIED_TEXT })
    expect(result.products).toBeUndefined()
    expect((await graphReservations(chatbotId)).every((r) => r.status === "expired")).toBe(true)
  })

  it("bookly: with no budget left the provider is never called and the turn is still handled politely", async () => {
    const chatbotId = await seedBookly("bookly-capped")
    await exhaustOpenAiBudget(chatbotId)
    llmInvoke.mockResolvedValue(providerReply("availability_question"))

    const result = await tryAnswerWithBooklyGraph(chatbotId, randomUUID(), "what's open tomorrow?")
    expect(llmInvoke).not.toHaveBeenCalled()
    expect(result).toEqual({ handled: true, text: LLM_BUDGET_DENIED_TEXT })
  })

  it("bookly admin: a denied reservation does not call the provider", async () => {
    const chatbotId = await seedBookly("admin-capped")
    await exhaustOpenAiBudget(chatbotId)
    llmInvoke.mockResolvedValue(providerReply("create_resource"))

    const update = await classifyAdminIntentNode({
      chatbotId,
      adminId: "admin-1",
      adminEmail: "admin@example.com",
      intent: null,
      draft: null,
      responseText: null,
      executedTargetId: null,
      messages: [{ role: "user", content: "create a resource called Room A" }],
      requestId: undefined,
      graphRunId: randomUUID(),
    })
    expect(llmInvoke).not.toHaveBeenCalled()
    expect(update).toEqual({ intent: "other", responseText: LLM_BUDGET_DENIED_TEXT })
  })

  it("a denial mid-order (build_order_draft) clears the draft and confirm_with_customer ends the turn without prompting", async () => {
    const chatbotId = await seedStore("draft-capped")
    await exhaustOpenAiBudget(chatbotId)
    const staleDraft = { lineItems: [{ wooProductId: 1, productName: "Old", quantity: 1, cachedUnitPrice: 1 }], customerFirstName: "A", customerLastName: null, customerEmail: "a@example.com", customerPhone: null }
    const state = { ...verifiedState(chatbotId, randomUUID(), "a@example.com"), intent: "order_intent", orderDraft: staleDraft }

    const update = await buildOrderDraftNode(state)
    expect(llmInvoke).not.toHaveBeenCalled()
    expect(update).toEqual({ orderDraft: null, responseText: LLM_BUDGET_DENIED_TEXT })
    expect(await confirmWithCustomerNode({ ...state, ...update })).toEqual({})
  })
})

describe("NEW-01 / CS-04 residual: order_status_lookup authorizes before any state transition", () => {
  beforeEach(() => {
    vi.mocked(wooConnector.getOrderStatus).mockReset()
  })

  async function seedPendingOrder(level: "EMAIL_VERIFIED" | "ORDER_VERIFIED") {
    const chatbotId = await seedStore(`order-${level}`)
    const email = `new01-${randomUUID().slice(0, 8)}@example.com`
    const { rows: customerRows } = await pool!.query(
      "insert into customer_identities (chatbot_id, email, verification_level) values ($1, $2, $3) returning id",
      [chatbotId, email, level],
    )
    const customerId = customerRows[0].id as string
    const { rows: orderRows } = await pool!.query(
      `insert into commerce_orders (chatbot_id, customer_id, woocommerce_order_id, idempotency_key, status, order_snapshot) values ($1, $2, '501', $3, 'PENDING_PAYMENT', '{"wooTotal": "20.00", "wooCurrency": "USD"}') returning id`,
      // CS-13: payment confirmation compares the paid total/currency with the snapshot.
      [chatbotId, customerId, randomUUID()],
    )
    vi.mocked(wooConnector.getOrderStatus).mockResolvedValue({
      id: 501, number: "501", order_key: "wc_order_abc", status: "processing", currency: "USD", total: "20.00",
      date_paid: "2026-01-01T00:00:00", payment_method: "x", payment_method_title: "x", line_items: [],
    } as never)
    return { chatbotId, customerId, email, orderId: orderRows[0].id as string }
  }

  async function orderRow(orderId: string) {
    const { rows } = await pool!.query("select status, booking_number, operational_status from commerce_orders where id = $1", [orderId])
    return rows[0]
  }

  it("an unauthorized lookup leaves the order untouched and never re-verifies with the store", async () => {
    const { chatbotId, customerId, email, orderId } = await seedPendingOrder("EMAIL_VERIFIED")

    const update = await orderStatusLookupNode(verifiedState(chatbotId, customerId, email))
    expect(update.responseText).toBe("I can't see a confirmed payment for your latest order yet.")
    expect(wooConnector.getOrderStatus).not.toHaveBeenCalled()
    expect(await orderRow(orderId)).toEqual({ status: "PENDING_PAYMENT", booking_number: null, operational_status: null })
  })

  it("an authorized lookup still re-verifies a pending order and reports the booking number", async () => {
    const { chatbotId, customerId, email, orderId } = await seedPendingOrder("ORDER_VERIFIED")

    const update = await orderStatusLookupNode(verifiedState(chatbotId, customerId, email))
    expect(wooConnector.getOrderStatus).toHaveBeenCalledTimes(1)
    const row = await orderRow(orderId)
    expect(row.status).toBe("PAID")
    expect(update.responseText).toContain(row.booking_number)
  })
})
