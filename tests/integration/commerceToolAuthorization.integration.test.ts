import { randomUUID } from "node:crypto"
import { describe, expect, it } from "vitest"

const { pool } = await import("../../src/lib/db.js")
const { authorizeToolCall } = await import("../../src/services/toolAuthorization.service.js")
const { signupUser } = await import("../helpers.js")

async function seedFullCustomStore(label: string) {
  const db = pool!
  const { user } = await signupUser(label)
  await db.query(`insert into subscriptions (user_id, stripe_customer_id, plan, status) values ($1, $2, 'full_custom', 'active')`, [user.id, `cus_${randomUUID()}`])
  const { rows: chatbotRows } = await db.query("insert into chatbots (user_id, name, sources, theme, status) values ($1, 'bot', '[]', '{}', 'ready') returning id", [user.id])
  const chatbotId = chatbotRows[0].id as string
  await db.query(`insert into chatbot_woocommerce_credentials (chatbot_id, store_url, consumer_key_encrypted, consumer_secret_encrypted, webhook_secret_encrypted) values ($1, 'https://shop.example.com', 'x', 'y', 'z')`, [chatbotId])
  const { rows: customerRows } = await db.query("insert into customer_identities (chatbot_id, email) values ($1, $2) returning id", [chatbotId, `c-${randomUUID()}@example.test`])
  return { chatbotId, customerId: customerRows[0].id as string }
}

describe("ToolAuthorizationPolicy — §9's central checkpoint", () => {
  it("allows a product lookup with no customer resolved yet (product questions require no verification)", async () => {
    const { chatbotId } = await seedFullCustomStore("authz-product")
    await expect(authorizeToolCall({ chatbotId, customerId: null, operation: "lookup_product" })).resolves.toBeUndefined()
  })

  it("denies every tool call for a chatbot with no WooCommerce connection at all", async () => {
    const db = pool!
    const { user } = await signupUser("authz-no-store")
    await db.query(`insert into subscriptions (user_id, stripe_customer_id, plan, status) values ($1, $2, 'full_custom', 'active')`, [user.id, `cus_${randomUUID()}`])
    const { rows } = await db.query("insert into chatbots (user_id, name, sources, theme, status) values ($1, 'bot', '[]', '{}', 'ready') returning id", [user.id])
    await expect(authorizeToolCall({ chatbotId: rows[0].id, customerId: null, operation: "lookup_product" })).rejects.toThrow(/no connected WooCommerce store/)
  })

  it("STORE A's conversation is denied when it tries to act on STORE B's customer identity — tenant isolation holds even if the id is supplied directly (adversarial-prompting scenario)", async () => {
    const storeA = await seedFullCustomStore("authz-tenant-a")
    const storeB = await seedFullCustomStore("authz-tenant-b")

    await expect(authorizeToolCall({ chatbotId: storeA.chatbotId, customerId: storeB.customerId, operation: "create_order" })).rejects.toThrow(/does not belong to this chatbot/)
  })

  it("STORE A's conversation is denied when it tries to look up STORE B's order", async () => {
    const storeA = await seedFullCustomStore("authz-order-a")
    const storeB = await seedFullCustomStore("authz-order-b")
    const db = pool!
    // storeA's customer needs to actually satisfy the ORDER_VERIFIED gate
    // itself first — otherwise this test would (correctly) fail at that
    // earlier, more basic check instead of exercising the resource-
    // ownership check this test is actually about.
    await db.query("update customer_identities set verification_level = 'ORDER_VERIFIED' where id = $1", [storeA.customerId])
    const { rows: orderRows } = await db.query(
      `insert into commerce_orders (chatbot_id, customer_id, woocommerce_order_id, idempotency_key, status, booking_number, order_snapshot) values ($1, $2, 'wc-1', $3, 'PAID', 'CM-ABC123', '{}') returning id`,
      [storeB.chatbotId, storeB.customerId, randomUUID()],
    )
    const storeBOrderId = orderRows[0].id as string

    await expect(
      authorizeToolCall({ chatbotId: storeA.chatbotId, customerId: storeA.customerId, operation: "get_order_status", resource: { type: "order", id: storeBOrderId } }),
    ).rejects.toThrow(/not found/i)
  })

  it("blocks an order-status lookup for a customer who hasn't been ORDER_VERIFIED yet (a fresh identity with no completed order)", async () => {
    const { chatbotId, customerId } = await seedFullCustomStore("authz-verification")
    await expect(authorizeToolCall({ chatbotId, customerId, operation: "get_order_status", resource: undefined })).rejects.toThrow(/requires verification level ORDER_VERIFIED/)
  })

  it("allows create_order for a freshly-resolved (UNVERIFIED) customer — placing a first order never requires prior verification", async () => {
    const { chatbotId, customerId } = await seedFullCustomStore("authz-first-order")
    await expect(authorizeToolCall({ chatbotId, customerId, operation: "create_order" })).resolves.toBeUndefined()
  })

  it("denies every tool call once the chatbot's plan is downgraded below Full Custom, even though the WooCommerce connection is still configured", async () => {
    const { chatbotId } = await seedFullCustomStore("authz-downgrade")
    const db = pool!
    await db.query("update subscriptions set plan = 'crawl_plus' where user_id = (select user_id from chatbots where id = $1)", [chatbotId])
    await expect(authorizeToolCall({ chatbotId, customerId: null, operation: "lookup_product" })).rejects.toThrow(/Full Custom/)
  })
})
