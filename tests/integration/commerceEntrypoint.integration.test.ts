import { randomUUID } from "node:crypto"
import { describe, expect, it, vi } from "vitest"

// Real bug found in live testing: when the commerce graph pauses via
// interrupt() to ask a clarifying question, the ACTUAL question is carried
// on the invoke() result's `__interrupt__` array (LangGraph's own
// mechanism), never in the typed `responseText` state field — reading only
// `responseText` meant every paused turn silently showed whatever stale
// text a PREVIOUS, unrelated, already-completed turn had left behind,
// repeated verbatim, no matter what the customer actually asked next.
const llmInvoke = vi.fn()
vi.mock("../../src/langgraph/llm.js", () => ({
  hasCommerceLlm: vi.fn(() => true),
  getCommerceLlm: vi.fn(() => ({ invoke: llmInvoke })),
}))

const { tryAnswerWithCommerceGraph } = await import("../../src/langgraph/commerceEntrypoint.js")
const { pool } = await import("../../src/lib/db.js")
const { encryptSecret } = await import("../../src/lib/crypto.js")
const { signupUser } = await import("../helpers.js")

async function seedFullCustomStoreWithProduct(label: string) {
  const db = pool!
  const { user } = await signupUser(label)
  await db.query(`insert into subscriptions (user_id, stripe_customer_id, plan, status) values ($1, $2, 'full_custom', 'active')`, [user.id, `cus_${randomUUID()}`])
  const { rows: chatbotRows } = await db.query("insert into chatbots (user_id, name, sources, theme, status) values ($1, 'bot', '[]', '{}', 'ready') returning id", [user.id])
  const chatbotId = chatbotRows[0].id as string
  await db.query(
    `insert into chatbot_woocommerce_credentials (chatbot_id, store_url, consumer_key_encrypted, consumer_secret_encrypted, webhook_secret_encrypted) values ($1, 'https://shop.example.com', $2, $3, $4)`,
    [chatbotId, encryptSecret("ck"), encryptSecret("cs"), encryptSecret("wh")],
  )
  await db.query(
    `insert into product_catalog_cache (chatbot_id, woocommerce_product_id, name, description, price, stock_quantity) values ($1, '1', 'Blue Widget', 'A nice widget', 20.00, 50)`,
    [chatbotId],
  )
  return chatbotId
}

describe("tryAnswerWithCommerceGraph — a paused turn shows the real pending question, never stale text from a prior turn", () => {
  it("a product question (answered and finished) followed by an order request (which pauses) shows the REAL clarifying question, not the previous answer repeated", async () => {
    llmInvoke.mockClear()
    const chatbotId = await seedFullCustomStoreWithProduct("entrypoint-interrupt")
    const conversationId = randomUUID()

    // Turn 1: a plain product question — completes in one turn.
    llmInvoke.mockResolvedValueOnce({ content: "product_question" })
    llmInvoke.mockResolvedValueOnce({ content: "Yes, the Blue Widget is $20.00 and in stock." })
    const turn1 = await tryAnswerWithCommerceGraph(chatbotId, conversationId, "Do you have the Blue Widget?", "req-1")
    expect(turn1.text).toContain("$20")

    // Turn 2: wants to order — build_order_draft is missing contact info
    // and PAUSES via interrupt(), asking for it.
    llmInvoke.mockResolvedValueOnce({ content: "order_intent" })
    llmInvoke.mockResolvedValueOnce({ content: JSON.stringify({ productIndex: 0, quantity: 1, firstName: null, lastName: null, email: null, phone: null }) })
    const turn2 = await tryAnswerWithCommerceGraph(chatbotId, conversationId, "I'd like to order one", "req-2")

    // The bug: this used to return turn1's stale "$20.00 and in stock"
    // text verbatim. It must instead be the real clarifying question.
    expect(turn2.text).not.toBe(turn1.text)
    expect(turn2.text).not.toContain("in stock")
    expect(turn2.text?.toLowerCase()).toMatch(/email|name|which product|how many/)
  })
})
