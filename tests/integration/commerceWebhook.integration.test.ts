import { createHmac, randomUUID } from "node:crypto"
import request from "supertest"
import { describe, expect, it, vi } from "vitest"

vi.mock("../../src/lib/commerceQueue.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/lib/commerceQueue.js")>("../../src/lib/commerceQueue.js")
  return { ...actual, enqueueCommerceWebhookProcessing: vi.fn(async () => {}) }
})

const { app, signupUser } = await import("../helpers.js")
const { pool } = await import("../../src/lib/db.js")
const commerceQueue = await import("../../src/lib/commerceQueue.js")

const WEBHOOK_SECRET = "whsec_test_secret"

async function seedFullCustomChatbotWithWebhook(label: string) {
  const db = pool!
  const { user } = await signupUser(label)
  await db.query(`insert into subscriptions (user_id, stripe_customer_id, plan, status) values ($1, $2, 'full_custom', 'active')`, [user.id, `cus_${randomUUID()}`])
  const { rows: chatbotRows } = await db.query("insert into chatbots (user_id, name, sources, theme, status) values ($1, 'bot', '[]', '{}', 'ready') returning id", [user.id])
  const chatbotId = chatbotRows[0].id as string
  const { encryptSecret } = await import("../../src/lib/crypto.js")
  await db.query(
    `insert into chatbot_woocommerce_credentials (chatbot_id, store_url, consumer_key_encrypted, consumer_secret_encrypted, webhook_secret_encrypted) values ($1, 'https://shop.example.com', $2, $3, $4)`,
    [chatbotId, encryptSecret("ck"), encryptSecret("cs"), encryptSecret(WEBHOOK_SECRET)],
  )
  return chatbotId
}

function sign(body: string, secret = WEBHOOK_SECRET): string {
  return createHmac("sha256", secret).update(body).digest("base64")
}

describe("POST /webhooks/woocommerce/:chatbotId — WooCommerce's own unsigned validation ping", () => {
  it("accepts the real WooCommerce validation ping (unsigned, body 'webhook_id=<n>') with a clean 200, never a crash", async () => {
    const chatbotId = await seedFullCustomChatbotWithWebhook("webhook-ping")
    const res = await request(app)
      .post(`/webhooks/woocommerce/${chatbotId}`)
      .set("Content-Type", "application/x-www-form-urlencoded")
      .send("webhook_id=1")
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
    // Never treated as a real event — no row written, nothing enqueued.
    const { rows } = await pool!.query("select * from commerce_webhook_events where chatbot_id = $1", [chatbotId])
    expect(rows).toHaveLength(0)
  })

  it("404s a validation ping for a chatbot with no WooCommerce connection — never a way to probe which chatbot ids exist", async () => {
    const res = await request(app)
      .post(`/webhooks/woocommerce/${randomUUID()}`)
      .set("Content-Type", "application/x-www-form-urlencoded")
      .send("webhook_id=1")
    expect(res.status).toBe(404)
  })

  it("never crashes on a bodyless/non-JSON request regardless of content type (the real bug that produced a 500 against a live WordPress site)", async () => {
    const chatbotId = await seedFullCustomChatbotWithWebhook("webhook-bodyless")
    const res = await request(app).post(`/webhooks/woocommerce/${chatbotId}`).set("Content-Type", "text/plain").set("X-WC-Webhook-Signature", "bogus")
    expect(res.status).toBe(401) // a clean rejection, not a 500
  })
})

describe("POST /webhooks/woocommerce/:chatbotId", () => {
  it("rejects a request with no signature header", async () => {
    const chatbotId = await seedFullCustomChatbotWithWebhook("webhook-nosig")
    const body = JSON.stringify({ id: 1, status: "processing" })
    const res = await request(app).post(`/webhooks/woocommerce/${chatbotId}`).set("Content-Type", "application/json").set("X-WC-Webhook-Topic", "order.updated").send(body)
    expect(res.status).toBe(401)
  })

  it("rejects a request with a tampered signature", async () => {
    const chatbotId = await seedFullCustomChatbotWithWebhook("webhook-tampered")
    const body = JSON.stringify({ id: 1, status: "processing" })
    const res = await request(app)
      .post(`/webhooks/woocommerce/${chatbotId}`)
      .set("Content-Type", "application/json")
      .set("X-WC-Webhook-Signature", sign(body, "wrong-secret"))
      .set("X-WC-Webhook-Topic", "order.updated")
      .send(body)
    expect(res.status).toBe(401)
  })

  it("404s for a chatbot with no WooCommerce connection configured (never leaks whether the chatbot itself exists)", async () => {
    const res = await request(app)
      .post(`/webhooks/woocommerce/${randomUUID()}`)
      .set("Content-Type", "application/json")
      .set("X-WC-Webhook-Signature", "whatever")
      .send(JSON.stringify({ id: 1 }))
    expect(res.status).toBe(404)
  })

  it("accepts a correctly-signed delivery, writes exactly one commerce_webhook_events row, and enqueues processing", async () => {
    const chatbotId = await seedFullCustomChatbotWithWebhook("webhook-ok")
    const body = JSON.stringify({ id: 12345, status: "processing", date_modified: "2026-01-01T00:00:00" })

    const res = await request(app)
      .post(`/webhooks/woocommerce/${chatbotId}`)
      .set("Content-Type", "application/json")
      .set("X-WC-Webhook-Signature", sign(body))
      .set("X-WC-Webhook-Topic", "order.updated")
      .send(body)

    expect(res.status).toBe(200)
    const { rows } = await pool!.query("select * from commerce_webhook_events where chatbot_id = $1", [chatbotId])
    expect(rows).toHaveLength(1)
    expect(rows[0].event_type).toBe("order.updated")
    expect(commerceQueue.enqueueCommerceWebhookProcessing).toHaveBeenCalledTimes(1)
  })

  it("a real retried delivery of the SAME event (identical payload) is idempotent — one row, no reprocessing enqueued twice", async () => {
    vi.mocked(commerceQueue.enqueueCommerceWebhookProcessing).mockClear()
    const chatbotId = await seedFullCustomChatbotWithWebhook("webhook-retry")
    const body = JSON.stringify({ id: 999, status: "processing", date_modified: "2026-02-02T00:00:00" })
    const signature = sign(body)

    const first = await request(app).post(`/webhooks/woocommerce/${chatbotId}`).set("Content-Type", "application/json").set("X-WC-Webhook-Signature", signature).set("X-WC-Webhook-Topic", "order.updated").send(body)
    const retry = await request(app).post(`/webhooks/woocommerce/${chatbotId}`).set("Content-Type", "application/json").set("X-WC-Webhook-Signature", signature).set("X-WC-Webhook-Topic", "order.updated").send(body)

    expect(first.status).toBe(200)
    expect(retry.status).toBe(200)
    const { rows } = await pool!.query("select * from commerce_webhook_events where chatbot_id = $1 and provider_event_id like 'order.updated:999:%'", [chatbotId])
    expect(rows).toHaveLength(1)
    expect(commerceQueue.enqueueCommerceWebhookProcessing).toHaveBeenCalledTimes(1)
  })

  it("two genuinely different state changes on the SAME resource (different date_modified) are NOT deduped — each is a real event", async () => {
    vi.mocked(commerceQueue.enqueueCommerceWebhookProcessing).mockClear()
    const chatbotId = await seedFullCustomChatbotWithWebhook("webhook-distinct")
    const bodyA = JSON.stringify({ id: 777, status: "pending", date_modified: "2026-03-01T00:00:00" })
    const bodyB = JSON.stringify({ id: 777, status: "processing", date_modified: "2026-03-01T00:05:00" })

    await request(app).post(`/webhooks/woocommerce/${chatbotId}`).set("Content-Type", "application/json").set("X-WC-Webhook-Signature", sign(bodyA)).set("X-WC-Webhook-Topic", "order.updated").send(bodyA)
    await request(app).post(`/webhooks/woocommerce/${chatbotId}`).set("Content-Type", "application/json").set("X-WC-Webhook-Signature", sign(bodyB)).set("X-WC-Webhook-Topic", "order.updated").send(bodyB)

    const { rows } = await pool!.query("select * from commerce_webhook_events where chatbot_id = $1 and provider_event_id like 'order.updated:777:%'", [chatbotId])
    expect(rows).toHaveLength(2)
  })
})
