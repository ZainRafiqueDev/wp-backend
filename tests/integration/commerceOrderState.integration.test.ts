import { randomUUID } from "node:crypto"
import { describe, expect, it, vi } from "vitest"

vi.mock("../../src/lib/woocommerce/connector.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/lib/woocommerce/connector.js")>("../../src/lib/woocommerce/connector.js")
  return { ...actual, getOrderStatus: vi.fn() }
})
vi.mock("../../src/services/commerceCredentials.service.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/services/commerceCredentials.service.js")>("../../src/services/commerceCredentials.service.js")
  return { ...actual, getDecryptedWooCommerceCredentials: vi.fn(async () => ({ storeUrl: "https://shop.example.com", consumerKey: "ck", consumerSecret: "cs" })) }
})

const { pool } = await import("../../src/lib/db.js")
const { transitionOrderState, getCommerceOrder } = await import("../../src/services/orderState.service.js")
const wooConnector = await import("../../src/lib/woocommerce/connector.js")
const { signupUser } = await import("../helpers.js")

function wooOrder(overrides: Partial<import("../../src/lib/woocommerce/types.js").WooCommerceOrder> = {}) {
  return {
    id: 501,
    number: "501",
    order_key: "wc_order_abc",
    status: "processing",
    currency: "USD",
    total: "20.00",
    date_paid: "2026-01-01T00:00:00",
    payment_method: "x",
    payment_method_title: "x",
    line_items: [],
    ...overrides,
  }
}

async function seedOrder(status: string, overrides: Record<string, unknown> = {}) {
  const db = pool!
  const { user } = await signupUser(`orderstate-${randomUUID()}`)
  const { rows: chatbotRows } = await db.query("insert into chatbots (user_id, name, sources, theme, status) values ($1, 'bot', '[]', '{}', 'ready') returning id", [user.id])
  const chatbotId = chatbotRows[0].id as string
  const { rows: customerRows } = await db.query("insert into customer_identities (chatbot_id, email) values ($1, $2) returning id", [chatbotId, `${randomUUID()}@example.test`])
  const customerId = customerRows[0].id as string
  const { rows: orderRows } = await db.query(
    `insert into commerce_orders (chatbot_id, customer_id, woocommerce_order_id, idempotency_key, status, order_snapshot)
     values ($1, $2, $3, $4, $5, $6) returning id`,
    [
      chatbotId,
      customerId,
      overrides.woocommerceOrderId ?? "501",
      randomUUID(),
      status,
      // CS-13: payment confirmation checks the paid total/currency against
      // the order snapshot, so seed one matching wooOrder() below.
      JSON.stringify(overrides.snapshot ?? { total: 20, currency: "USD" }),
    ],
  )
  return { chatbotId, customerId, orderId: orderRows[0].id as string }
}

describe("transitionOrderState — the only legal way to change commerce_orders.status", () => {
  it("allows every valid edge in the machine", async () => {
    vi.mocked(wooConnector.getOrderStatus).mockResolvedValue(wooOrder({ status: "processing", date_paid: "2026-01-01" }))

    const { orderId } = await seedOrder("DRAFT")
    expect((await transitionOrderState(orderId, "PENDING_PAYMENT", { source: "manual" })).order.status).toBe("PENDING_PAYMENT")
    expect((await transitionOrderState(orderId, "PAID", { source: "manual" })).order.status).toBe("PAID")
    expect((await transitionOrderState(orderId, "PROCESSING", { source: "manual" })).order.status).toBe("PROCESSING")
    expect((await transitionOrderState(orderId, "SHIPPED", { source: "manual" })).order.status).toBe("SHIPPED")
    expect((await transitionOrderState(orderId, "DELIVERED", { source: "manual" })).order.status).toBe("DELIVERED")
  })

  it("rejects every invalid transition", async () => {
    const invalidPairs: [string, string][] = [
      ["DELIVERED", "PENDING_PAYMENT"],
      ["PAID", "DRAFT"],
      ["CANCELLED", "PAID"],
      ["REFUNDED", "PAID"],
      ["DRAFT", "PAID"],
      ["DRAFT", "PROCESSING"],
      ["PENDING_PAYMENT", "SHIPPED"],
      ["PAID", "DELIVERED"],
      ["PROCESSING", "PAID"],
      ["SHIPPED", "CANCELLED"],
    ]
    for (const [from, to] of invalidPairs) {
      const { orderId } = await seedOrder(from)
      await expect(transitionOrderState(orderId, to as never, { source: "manual" })).rejects.toThrow(/Cannot transition/)
    }
  })

  it("is idempotent: transitioning to the same state is a no-op, not an error", async () => {
    const { orderId } = await seedOrder("PROCESSING")
    const result = await transitionOrderState(orderId, "PROCESSING", { source: "manual" })
    expect(result.changed).toBe(false)
    expect(result.order.status).toBe("PROCESSING")
  })

  it("404s for a nonexistent order", async () => {
    await expect(transitionOrderState(randomUUID(), "PAID", { source: "manual" })).rejects.toThrow(/not found/i)
  })
})

describe("PENDING_PAYMENT -> PAID — the non-negotiable payment invariant", () => {
  it("generates a booking number ONLY when PaymentConfirmationPolicy confirms real, fresh WooCommerce data", async () => {
    vi.mocked(wooConnector.getOrderStatus).mockResolvedValue(wooOrder({ status: "processing", date_paid: "2026-01-01" }))
    const { orderId } = await seedOrder("PENDING_PAYMENT")

    const result = await transitionOrderState(orderId, "PAID", { source: "webhook" })
    expect(result.changed).toBe(true)
    expect(result.order.status).toBe("PAID")
    expect(result.order.bookingNumber).toMatch(/^CM-/)
    expect(result.order.paidAt).not.toBeNull()
  })

  it("does NOT transition and does NOT generate a booking number when the real WooCommerce order is still unpaid — this is what makes a bare 'I already paid' claim unable to produce one", async () => {
    vi.mocked(wooConnector.getOrderStatus).mockResolvedValue(wooOrder({ status: "pending", date_paid: null }))
    const { orderId } = await seedOrder("PENDING_PAYMENT")

    const result = await transitionOrderState(orderId, "PAID", { source: "manual" })
    expect(result.changed).toBe(false)
    expect(result.order.status).toBe("PENDING_PAYMENT")
    expect(result.order.bookingNumber).toBeNull()
    expect(result.order.operationalStatus).toBe("PAYMENT_VERIFICATION_PENDING")
  })

  it("retries booking-number generation on a real unique-constraint collision", async () => {
    vi.mocked(wooConnector.getOrderStatus).mockResolvedValue(wooOrder({ status: "processing", date_paid: "2026-01-01" }))
    const { chatbotId, orderId } = await seedOrder("PENDING_PAYMENT")

    // A real collision: another order on the SAME chatbot already holds a
    // fixed booking number; force the generator to hand that one out first.
    const db = pool!
    const collidingCandidate = "CM-COLLID"
    const { rows: other } = await db.query("select id from customer_identities where chatbot_id = $1 limit 1", [chatbotId])
    await db.query(
      `insert into commerce_orders (chatbot_id, customer_id, woocommerce_order_id, idempotency_key, status, booking_number, order_snapshot)
       values ($1, $2, 'wc-other', $3, 'PAID', $4, '{}')`,
      [chatbotId, other[0].id, randomUUID(), collidingCandidate],
    )

    const mod = await import("../../src/lib/woocommerce/bookingNumber.js")
    const spy = vi.spyOn(mod, "generateBookingNumberCandidate")
    spy.mockReturnValueOnce(collidingCandidate).mockReturnValueOnce("CM-RETRY1")

    const result = await transitionOrderState(orderId, "PAID", { source: "manual" })
    expect(result.changed).toBe(true)
    expect(result.order.bookingNumber).toBe("CM-RETRY1")
    expect(spy).toHaveBeenCalledTimes(2)
    spy.mockRestore()
  })

  it("real concurrency: two near-simultaneous PENDING_PAYMENT->PAID attempts on the SAME order only ever produce ONE booking number (real Postgres row lock, not a mocked one)", async () => {
    vi.mocked(wooConnector.getOrderStatus).mockResolvedValue(wooOrder({ status: "processing", date_paid: "2026-01-01" }))
    const { orderId } = await seedOrder("PENDING_PAYMENT")

    const [a, b] = await Promise.all([
      transitionOrderState(orderId, "PAID", { source: "webhook" }),
      transitionOrderState(orderId, "PAID", { source: "webhook" }),
    ])

    const bookingNumbers = new Set([a.order.bookingNumber, b.order.bookingNumber])
    expect(bookingNumbers.size).toBe(1)
    expect([...bookingNumbers][0]).toMatch(/^CM-/)
    // Exactly one of the two calls actually performed the transition; the
    // other observed the already-PAID row (via the real FOR UPDATE lock
    // forcing it to wait) and returned it as a no-op.
    expect([a.changed, b.changed].filter(Boolean)).toHaveLength(1)

    const finalOrder = await getCommerceOrder(orderId)
    expect(finalOrder?.status).toBe("PAID")
    expect(finalOrder?.bookingNumber).toBe([...bookingNumbers][0])
  })
})

// CS-13 (B05-012 / B10-014 / B09-008): regression tests that fail on the
// pre-CS-13 policy (processing == paid, no amount check).
describe("CS-13 payment confirmation hardening", () => {
  it("an unpaid cash-on-delivery 'processing' order (no date_paid) does NOT become PAID", async () => {
    const { orderId } = await seedOrder("PENDING_PAYMENT")
    vi.mocked(wooConnector.getOrderStatus).mockResolvedValue(
      wooOrder({ status: "processing", payment_method: "cod", payment_method_title: "Cash on delivery", date_paid: null }),
    )
    const result = await transitionOrderState(orderId, "PAID", { source: "webhook" })
    expect(result.changed).toBe(false)
    const after = await getCommerceOrder(orderId)
    expect(after?.status).toBe("PENDING_PAYMENT")
    expect(after?.bookingNumber).toBeNull()
  })

  it("an underpaid order (snapshot 50.00, WooCommerce total 1.00) does NOT become PAID", async () => {
    const { orderId } = await seedOrder("PENDING_PAYMENT", { snapshot: { total: 50, currency: "USD" } })
    vi.mocked(wooConnector.getOrderStatus).mockResolvedValue(wooOrder({ total: "1.00" }))
    const result = await transitionOrderState(orderId, "PAID", { source: "webhook" })
    expect(result.changed).toBe(false)
    const after = await getCommerceOrder(orderId)
    expect(after?.status).toBe("PENDING_PAYMENT")
    expect(after?.bookingNumber).toBeNull()
    expect(after?.operationalStatus).toBe("PAYMENT_VERIFICATION_FAILED")
  })

  it("a payment in a different currency does NOT mark the order PAID", async () => {
    const { orderId } = await seedOrder("PENDING_PAYMENT", { snapshot: { total: 20, currency: "USD", wooTotal: "20.00", wooCurrency: "USD" } })
    vi.mocked(wooConnector.getOrderStatus).mockResolvedValue(wooOrder({ total: "20.00", currency: "PKR" }))
    const result = await transitionOrderState(orderId, "PAID", { source: "webhook" })
    expect(result.changed).toBe(false)
    expect((await getCommerceOrder(orderId))?.status).toBe("PENDING_PAYMENT")
  })

  it("a fully paid order matching the WooCommerce total recorded at creation becomes PAID", async () => {
    const { orderId } = await seedOrder("PENDING_PAYMENT", { snapshot: { total: 18, currency: "USD", wooTotal: "20.00", wooCurrency: "USD" } })
    vi.mocked(wooConnector.getOrderStatus).mockResolvedValue(wooOrder({ total: "20.00" }))
    const result = await transitionOrderState(orderId, "PAID", { source: "webhook" })
    expect(result.changed).toBe(true)
    expect(result.order.bookingNumber).toMatch(/^CM-/)
  })
})
