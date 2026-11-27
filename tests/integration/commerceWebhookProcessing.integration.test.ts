import { randomUUID } from "node:crypto"
import { describe, expect, it, vi } from "vitest"

vi.mock("../../src/lib/woocommerce/connector.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/lib/woocommerce/connector.js")>("../../src/lib/woocommerce/connector.js")
  return { ...actual, getOrderStatus: vi.fn() }
})

const { pool } = await import("../../src/lib/db.js")
const { processCommerceWebhookEvent } = await import("../../src/services/commerceWebhookProcessing.service.js")
const wooConnector = await import("../../src/lib/woocommerce/connector.js")
const { encryptSecret } = await import("../../src/lib/crypto.js")
const { signupUser } = await import("../helpers.js")

async function seedPendingOrderWithWebhookEvent() {
  const db = pool!
  const { user } = await signupUser(`webhookproc-${randomUUID()}`)
  await db.query(`insert into subscriptions (user_id, stripe_customer_id, plan, status) values ($1, $2, 'full_custom', 'active')`, [user.id, `cus_${randomUUID()}`])
  const { rows: chatbotRows } = await db.query("insert into chatbots (user_id, name, sources, theme, status) values ($1, 'bot', '[]', '{}', 'ready') returning id", [user.id])
  const chatbotId = chatbotRows[0].id as string
  await db.query(
    `insert into chatbot_woocommerce_credentials (chatbot_id, store_url, consumer_key_encrypted, consumer_secret_encrypted, webhook_secret_encrypted) values ($1, 'https://shop.example.com', $2, $3, $4)`,
    [chatbotId, encryptSecret("ck"), encryptSecret("cs"), encryptSecret("wh")],
  )
  const { rows: customerRows } = await db.query("insert into customer_identities (chatbot_id, email) values ($1, $2) returning id", [chatbotId, `c-${randomUUID()}@example.test`])
  const customerId = customerRows[0].id as string
  const { rows: orderRows } = await db.query(
    `insert into commerce_orders (chatbot_id, customer_id, woocommerce_order_id, idempotency_key, status, order_snapshot) values ($1, $2, '4242', $3, 'PENDING_PAYMENT', '{"total": 10, "currency": "USD"}') returning id`,
    [chatbotId, customerId, randomUUID()],
  )
  const orderId = orderRows[0].id as string
  const { rows: eventRows } = await db.query(
    `insert into commerce_webhook_events (chatbot_id, provider_event_id, event_type, payload) values ($1, $2, 'order.updated', $3) returning id`,
    [chatbotId, `order.updated:4242:${randomUUID()}`, JSON.stringify({ id: 4242, status: "processing" })],
  )
  return { chatbotId, customerId, orderId, eventId: eventRows[0].id as string }
}

describe("commerceWebhookProcessing — a webhook-driven payment-confirmed event", () => {
  it("re-verifies against fresh WooCommerce data (never trusts the stored payload alone), transitions PENDING_PAYMENT -> PAID, generates a booking number ONLY now, marks the event processed, and writes a customer_notifications row", async () => {
    vi.mocked(wooConnector.getOrderStatus).mockResolvedValueOnce({
      id: 4242, number: "4242", order_key: "k", status: "processing", currency: "USD", total: "10.00", date_paid: "2026-01-01T00:00:00", payment_method: "x", payment_method_title: "x", line_items: [],
    })

    const { chatbotId, customerId, orderId, eventId } = await seedPendingOrderWithWebhookEvent()

    // Before processing: no booking number, no notification.
    const before = await pool!.query("select status, booking_number from commerce_orders where id = $1", [orderId])
    expect(before.rows[0].status).toBe("PENDING_PAYMENT")
    expect(before.rows[0].booking_number).toBeNull()

    await processCommerceWebhookEvent(chatbotId, eventId)

    // The fresh WooCommerce fetch is what actually happened — never trusted
    // the webhook payload's own "status": "processing" string directly.
    expect(wooConnector.getOrderStatus).toHaveBeenCalledWith(expect.anything(), 4242)

    const after = await pool!.query("select status, booking_number, paid_at from commerce_orders where id = $1", [orderId])
    expect(after.rows[0].status).toBe("PAID")
    expect(after.rows[0].booking_number).toMatch(/^CM-/)
    expect(after.rows[0].paid_at).not.toBeNull()

    const event = await pool!.query("select processed_at from commerce_webhook_events where id = $1", [eventId])
    expect(event.rows[0].processed_at).not.toBeNull()

    const notifications = await pool!.query("select * from customer_notifications where customer_id = $1", [customerId])
    expect(notifications.rows).toHaveLength(1)
    expect(notifications.rows[0].type).toBe("payment_confirmed")
    expect((notifications.rows[0].payload as { bookingNumber: string }).bookingNumber).toBe(after.rows[0].booking_number)
    expect(notifications.rows[0].delivered_at).toBeNull()
  })

  it("does NOT transition or generate a booking number when the fresh WooCommerce check disagrees with the stored payload's claimed status", async () => {
    vi.mocked(wooConnector.getOrderStatus).mockResolvedValueOnce({
      id: 4242, number: "4242", order_key: "k", status: "pending", currency: "USD", total: "10.00", date_paid: null, payment_method: "x", payment_method_title: "x", line_items: [],
    })
    const { orderId, chatbotId, eventId } = await seedPendingOrderWithWebhookEvent()

    await processCommerceWebhookEvent(chatbotId, eventId)

    const after = await pool!.query("select status, booking_number from commerce_orders where id = $1", [orderId])
    expect(after.rows[0].status).toBe("PENDING_PAYMENT")
    expect(after.rows[0].booking_number).toBeNull()
  })

  it("ignores an order.* event for a woocommerce_order_id this system never created (not tracked through this pipeline)", async () => {
    const db = pool!
    const { user } = await signupUser(`webhookproc-untracked-${randomUUID()}`)
    const { rows: chatbotRows } = await db.query("insert into chatbots (user_id, name, sources, theme, status) values ($1, 'bot', '[]', '{}', 'ready') returning id", [user.id])
    const chatbotId = chatbotRows[0].id as string
    const { rows: eventRows } = await db.query(
      `insert into commerce_webhook_events (chatbot_id, provider_event_id, event_type, payload) values ($1, $2, 'order.updated', $3) returning id`,
      [chatbotId, `order.updated:99999:${randomUUID()}`, JSON.stringify({ id: 99999, status: "processing" })],
    )
    await expect(processCommerceWebhookEvent(chatbotId, eventRows[0].id)).resolves.not.toThrow()
    const event = await db.query("select processed_at from commerce_webhook_events where id = $1", [eventRows[0].id])
    expect(event.rows[0].processed_at).not.toBeNull()
  })
})
