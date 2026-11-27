import { randomUUID } from "node:crypto"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../../src/lib/woocommerce/connector.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/lib/woocommerce/connector.js")>("../../src/lib/woocommerce/connector.js")
  return { ...actual, createOrder: vi.fn() }
})

const { pool } = await import("../../src/lib/db.js")
const { commitOrder } = await import("../../src/services/commerceOrder.service.js")
const wooConnector = await import("../../src/lib/woocommerce/connector.js")
const { signupUser } = await import("../helpers.js")

const CREDS = { storeUrl: "https://shop.example.com", consumerKey: "ck", consumerSecret: "cs" }

async function seedFullCustomChatbotWithCustomer(label: string) {
  const db = pool!
  const { user } = await signupUser(label)
  await db.query(`insert into subscriptions (user_id, stripe_customer_id, plan, status) values ($1, $2, 'full_custom', 'active')`, [user.id, `cus_${randomUUID()}`])
  const { rows: chatbotRows } = await db.query("insert into chatbots (user_id, name, sources, theme, status) values ($1, 'bot', '[]', '{}', 'ready') returning id", [user.id])
  const chatbotId = chatbotRows[0].id as string
  await db.query(
    `insert into chatbot_woocommerce_credentials (chatbot_id, store_url, consumer_key_encrypted, consumer_secret_encrypted, webhook_secret_encrypted) values ($1, $2, 'x', 'y', 'z')`,
    [chatbotId, CREDS.storeUrl],
  )
  const { rows: customerRows } = await db.query("insert into customer_identities (chatbot_id, email) values ($1, $2) returning id", [chatbotId, `c-${randomUUID()}@example.test`])
  return { chatbotId, customerId: customerRows[0].id as string }
}

function snapshot() {
  return { lineItems: [{ productId: 1, productName: "Widget", sku: null, quantity: 1, unitPrice: 10, subtotal: 10 }], shipping: 0, tax: 0, total: 10, currency: "USD" }
}

describe("commitOrder — the only caller of WooCommerceConnector.createOrder(), idempotent", () => {
  beforeEach(() => {
    vi.mocked(wooConnector.createOrder).mockReset()
  })

  it("creates exactly one real WooCommerce order for a fresh idempotency key", async () => {
    vi.mocked(wooConnector.createOrder).mockResolvedValueOnce({ id: 900, number: "900", order_key: "wc_key_1", status: "pending", currency: "USD", total: "10.00", date_paid: null, payment_method: "chatmate360", payment_method_title: "x", line_items: [] })
    const { chatbotId, customerId } = await seedFullCustomChatbotWithCustomer("commit-fresh")

    const result = await commitOrder({ chatbotId, customerId, creds: CREDS, snapshot: snapshot(), customer: { firstName: "Ada", lastName: "Lovelace", email: "ada@example.com" }, idempotencyKey: randomUUID() })
    expect(result.order.status).toBe("PENDING_PAYMENT")
    expect(result.order.bookingNumber).toBeNull()
    expect(result.paymentUrl).toContain("order-pay/900")
    expect(wooConnector.createOrder).toHaveBeenCalledTimes(1)
  })

  it("a retried commit attempt with the SAME idempotency key never calls WooCommerce a second time", async () => {
    vi.mocked(wooConnector.createOrder).mockResolvedValueOnce({ id: 901, number: "901", order_key: "wc_key_2", status: "pending", currency: "USD", total: "10.00", date_paid: null, payment_method: "chatmate360", payment_method_title: "x", line_items: [] })
    const { chatbotId, customerId } = await seedFullCustomChatbotWithCustomer("commit-idem")
    const idempotencyKey = randomUUID()
    const input = { chatbotId, customerId, creds: CREDS, snapshot: snapshot(), customer: { firstName: "Ada", lastName: "Lovelace", email: "ada@example.com" }, idempotencyKey }

    const first = await commitOrder(input)
    const second = await commitOrder(input)

    expect(wooConnector.createOrder).toHaveBeenCalledTimes(1)
    expect(second.order.id).toBe(first.order.id)
    expect(second.order.woocommerceOrderId).toBe(first.order.woocommerceOrderId)
    expect(second.paymentUrl).toBe(first.paymentUrl)
  })

  it("real concurrency: two near-simultaneous commit attempts with the same idempotency key still only create ONE real WooCommerce order", async () => {
    vi.mocked(wooConnector.createOrder).mockResolvedValueOnce({ id: 902, number: "902", order_key: "wc_key_3", status: "pending", currency: "USD", total: "10.00", date_paid: null, payment_method: "chatmate360", payment_method_title: "x", line_items: [] })
    const { chatbotId, customerId } = await seedFullCustomChatbotWithCustomer("commit-race")
    const idempotencyKey = randomUUID()
    const input = { chatbotId, customerId, creds: CREDS, snapshot: snapshot(), customer: { firstName: "Ada", lastName: "Lovelace", email: "ada@example.com" }, idempotencyKey }

    const results = await Promise.allSettled([commitOrder(input), commitOrder(input)])
    // Exactly one createOrder call across both attempts, regardless of
    // whether the loser succeeded (replay) or got a 409 "in progress".
    expect(wooConnector.createOrder).toHaveBeenCalledTimes(1)
    const fulfilled = results.filter((r) => r.status === "fulfilled") as PromiseFulfilledResult<Awaited<ReturnType<typeof commitOrder>>>[]
    expect(fulfilled.length).toBeGreaterThanOrEqual(1)
  })

  it("a different idempotency key on the same chatbot creates a genuinely separate order", async () => {
    vi.mocked(wooConnector.createOrder)
      .mockResolvedValueOnce({ id: 903, number: "903", order_key: "k3", status: "pending", currency: "USD", total: "10.00", date_paid: null, payment_method: "x", payment_method_title: "x", line_items: [] })
      .mockResolvedValueOnce({ id: 904, number: "904", order_key: "k4", status: "pending", currency: "USD", total: "10.00", date_paid: null, payment_method: "x", payment_method_title: "x", line_items: [] })
    const { chatbotId, customerId } = await seedFullCustomChatbotWithCustomer("commit-two-orders")

    const first = await commitOrder({ chatbotId, customerId, creds: CREDS, snapshot: snapshot(), customer: { firstName: "A", lastName: "B", email: "a@example.com" }, idempotencyKey: randomUUID() })
    const second = await commitOrder({ chatbotId, customerId, creds: CREDS, snapshot: snapshot(), customer: { firstName: "A", lastName: "B", email: "a@example.com" }, idempotencyKey: randomUUID() })

    expect(wooConnector.createOrder).toHaveBeenCalledTimes(2)
    expect(first.order.id).not.toBe(second.order.id)
  })
})

// CS-13 (B06-018): failure paths leave a recoverable state.
describe("CS-13 commitOrder failure recovery", () => {
  beforeEach(() => {
    vi.mocked(wooConnector.createOrder).mockReset()
  })

  it("a WooCommerce create failure leaves the key retryable: the next attempt with the SAME key creates the order", async () => {
    const { chatbotId, customerId } = await seedFullCustomChatbotWithCustomer(`commit-retry-${randomUUID()}`)
    const idempotencyKey = randomUUID()
    vi.mocked(wooConnector.createOrder)
      .mockRejectedValueOnce(new Error("WooCommerce timed out"))
      .mockResolvedValueOnce({ id: 950, number: "950", order_key: "wc_key_950", status: "pending", currency: "USD", total: "10.00", date_paid: null, payment_method: "chatmate360", payment_method_title: "x", line_items: [] })

    const input = { chatbotId, customerId, creds: CREDS, snapshot: snapshot(), customer: { firstName: "A", lastName: "B", email: "a@example.test" }, idempotencyKey }
    await expect(commitOrder(input)).rejects.toThrow(/timed out/)

    const retried = await commitOrder(input)
    expect(retried.order.status).toBe("PENDING_PAYMENT")
    expect(retried.order.woocommerceOrderId).toBe("950")
    expect(vi.mocked(wooConnector.createOrder)).toHaveBeenCalledTimes(2)

    const { rows } = await pool!.query("select count(*)::int as n from commerce_orders where chatbot_id = $1 and idempotency_key = $2", [chatbotId, idempotencyKey])
    expect(rows[0].n).toBe(1)
  })

  it("records WooCommerce's own total and currency on the snapshot for later payment verification", async () => {
    const { chatbotId, customerId } = await seedFullCustomChatbotWithCustomer(`commit-total-${randomUUID()}`)
    vi.mocked(wooConnector.createOrder).mockResolvedValueOnce({ id: 951, number: "951", order_key: "wc_key_951", status: "pending", currency: "USD", total: "12.50", date_paid: null, payment_method: "chatmate360", payment_method_title: "x", line_items: [] })
    const result = await commitOrder({ chatbotId, customerId, creds: CREDS, snapshot: snapshot(), customer: { firstName: "A", lastName: "B", email: "a@example.test" }, idempotencyKey: randomUUID() })
    expect(result.order.orderSnapshot).toMatchObject({ wooTotal: "12.50", wooCurrency: "USD" })
  })
})
