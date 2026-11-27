import { randomUUID } from "node:crypto"
import { describe, expect, it, vi } from "vitest"

// Scripted LLM — the graph's own reasoning model (§4's classify_intent,
// build_order_draft's extraction, confirm_with_customer's yes/no
// classification), completely separate from the real lib/ai.ts pipeline.
// Responses are consumed in the exact order the graph calls them.
const llmInvoke = vi.fn()
vi.mock("../../src/langgraph/llm.js", () => ({
  hasCommerceLlm: vi.fn(() => true),
  getCommerceLlm: vi.fn(() => ({ invoke: llmInvoke })),
}))

vi.mock("../../src/lib/woocommerce/connector.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/lib/woocommerce/connector.js")>("../../src/lib/woocommerce/connector.js")
  return { ...actual, getProduct: vi.fn(), checkStock: vi.fn(), createOrder: vi.fn() }
})

const { Command } = await import("@langchain/langgraph")
const { pool } = await import("../../src/lib/db.js")
const { getCommerceGraph } = await import("../../src/langgraph/commerceGraph.js")
const wooConnector = await import("../../src/lib/woocommerce/connector.js")
const { encryptSecret } = await import("../../src/lib/crypto.js")
const { signupUser } = await import("../helpers.js")

async function seedFullCustomStoreWithProduct() {
  const db = pool!
  const { user } = await signupUser(`graphrun-${randomUUID()}`)
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

describe("Full commerce graph run — real interrupt/resume against the real Postgres checkpointer", () => {
  it("product question -> draft -> confirm -> final validation catches a real price change -> order created PENDING_PAYMENT with a real payment URL, no booking number yet", async () => {
    const chatbotId = await seedFullCustomStoreWithProduct()
    const graph = await getCommerceGraph()
    const threadId = randomUUID()
    const config = { configurable: { thread_id: threadId } }
    const graphRunId = randomUUID()

    // Turn 1: classify_intent -> order_intent, then build_order_draft's
    // first extraction pass finds the product+quantity but not contact
    // info, and pauses (interrupt) asking for it.
    llmInvoke.mockResolvedValueOnce({ content: "order_intent" })
    llmInvoke.mockResolvedValueOnce({ content: JSON.stringify({ productIndex: 0, quantity: 2, firstName: null, lastName: null, email: null, phone: null }) })

    const turn1 = await graph.invoke({ chatbotId, requestId: "req-1", graphRunId, messages: [{ role: "user", content: "I'd like 2 Blue Widgets" }] }, config)
    const snapshotAfterTurn1 = await graph.getState(config)
    expect(snapshotAfterTurn1.next.length).toBeGreaterThan(0) // genuinely paused, not finished
    expect(turn1).toBeDefined()

    // Turn 2: customer supplies contact info -> extraction now complete ->
    // build_order_draft finishes -> confirm_with_customer asks for
    // explicit yes/no and pauses again.
    llmInvoke.mockResolvedValueOnce({ content: JSON.stringify({ productIndex: 0, quantity: 2, firstName: "Ada", lastName: "Lovelace", email: "ada@example.com", phone: null }) })

    await graph.invoke(new Command({ resume: "I'm Ada Lovelace, ada@example.com" }), config)
    const snapshotAfterTurn2 = await graph.getState(config)
    expect(snapshotAfterTurn2.next.length).toBeGreaterThan(0)

    // Turn 3: customer confirms at the cached $20 price. final_validation
    // hits the (mocked) LIVE WooCommerce product and finds it's actually
    // now $25 — §4's explicit "STOP, do not silently proceed at the new
    // price" case. This loops back to confirm_with_customer instead of
    // committing.
    vi.mocked(wooConnector.getProduct).mockResolvedValue({ id: 1, name: "Blue Widget", description: "x", price: "25.00", regular_price: "25.00", stock_quantity: 50, stock_status: "instock", manage_stock: true, permalink: "https://shop.example.com/product/blue-widget", images: [{ src: "https://shop.example.com/blue-widget.jpg" }] })
    vi.mocked(wooConnector.checkStock).mockResolvedValue({ inStock: true, quantity: 50 })
    llmInvoke.mockResolvedValueOnce({ content: "yes" })

    await graph.invoke(new Command({ resume: "yes" }), config)
    const snapshotAfterTurn3 = await graph.getState(config)
    expect(snapshotAfterTurn3.next.length).toBeGreaterThan(0) // paused AGAIN — price changed, re-confirming
    expect(snapshotAfterTurn3.values.validationIssue).toContain("price")

    // Turn 4: customer confirms again at the NEW ($25) price. This time
    // final_validation sees no further change (still $25) and commit_order
    // runs — the ONLY place WooCommerceConnector.createOrder() is ever
    // called.
    vi.mocked(wooConnector.createOrder).mockResolvedValueOnce({
      id: 5001, number: "5001", order_key: "wc_order_key_abc", status: "pending", currency: "USD", total: "50.00", date_paid: null, payment_method: "chatmate360", payment_method_title: "x", line_items: [],
    })
    llmInvoke.mockResolvedValueOnce({ content: "yes" })

    const finalTurn = await graph.invoke(new Command({ resume: "yes, go ahead" }), config)

    expect(wooConnector.createOrder).toHaveBeenCalledTimes(1)
    expect(finalTurn.responseText).toContain("order-pay/5001")
    // Explicitly does NOT claim the order/payment is confirmed — it says
    // the opposite ("isn't confirmed yet"), never a bare affirmative claim.
    expect(finalTurn.responseText).toMatch(/isn't confirmed|not confirmed|no booking number yet/i)
    expect(finalTurn.responseText).not.toMatch(/order is confirmed|payment (is |has been )?confirmed|your booking number is/i)
    expect(finalTurn.committedOrderId).toBeTruthy()

    const orderRow = await pool!.query("select status, booking_number, woocommerce_order_id from commerce_orders where id = $1", [finalTurn.committedOrderId])
    expect(orderRow.rows[0].status).toBe("PENDING_PAYMENT")
    expect(orderRow.rows[0].booking_number).toBeNull() // explicitly no booking number yet — payment hasn't happened
    expect(orderRow.rows[0].woocommerce_order_id).toBe("5001")

    const finalSnapshot = await graph.getState(config)
    expect(finalSnapshot.next).toHaveLength(0) // graph run genuinely finished
  })

  // Regression test #1: classify_intent -> "product_question" was routed
  // straight to END, completely bypassing product_lookup (the node that
  // actually answers a product question) — every plain product question
  // silently got the generic entrypoint fallback ("Sorry, I didn't quite
  // catch that.") instead of a real answer. Only surfaced against a real
  // WordPress store's live product data, since the scripted test above
  // only ever exercises "order_intent". Fixed in commerceGraph.ts's
  // routeFromClassify.
  //
  // Regression test #2 (same test, caught in the same live-testing pass):
  // product_lookup's product_question branch originally just formatted the
  // raw top-N vector-search matches as a list (name + price), regardless
  // of what was actually asked — a question about colors, capacity, or a
  // specific product's price got the exact same generic list back every
  // time, never a real answer. Fixed by passing the real product data
  // through the graph's own LLM to synthesize an answer grounded in it
  // (never inventing an attribute — e.g. color — that isn't actually in
  // the stored name/description/price/stock).
  it("a plain product question is answered from real catalog data, synthesized by the LLM rather than a raw list dump, not silently dropped", async () => {
    vi.mocked(wooConnector.createOrder).mockClear()
    llmInvoke.mockClear()
    const chatbotId = await seedFullCustomStoreWithProduct()
    const graph = await getCommerceGraph()
    const config = { configurable: { thread_id: randomUUID() } }

    llmInvoke.mockResolvedValueOnce({ content: "product_question" })
    llmInvoke.mockResolvedValueOnce({ content: "Yes! The Blue Widget is in stock for $20.00." })

    const result = await graph.invoke(
      { chatbotId, requestId: "req-pq", graphRunId: randomUUID(), messages: [{ role: "user", content: "Do you have the Blue Widget in stock, and how much is it?" }] },
      config,
    )

    expect(result.responseText).toBeTruthy()
    expect(result.responseText).not.toMatch(/didn't quite catch that/i)
    // The synthesis prompt was actually invoked with the real product data
    // as grounding context (not just re-emitted verbatim as a list).
    const synthesisCall = llmInvoke.mock.calls[1][0]
    expect(String(synthesisCall[0].content)).toContain("Blue Widget")
    expect(String(synthesisCall[0].content)).toContain("$20")
    expect(String(synthesisCall[0].content)).toContain("Do you have the Blue Widget in stock")

    const snapshot = await graph.getState(config)
    expect(snapshot.next).toHaveLength(0) // finished in one turn, no interrupt for a plain question
    expect(wooConnector.createOrder).not.toHaveBeenCalled()
  })
})
