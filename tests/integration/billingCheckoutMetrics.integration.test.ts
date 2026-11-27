import { randomUUID } from "node:crypto"
import { describe, expect, it, vi } from "vitest"

const incrementBillingMetric = vi.fn(async () => {})

vi.mock("../../src/lib/billingMetrics.js", () => ({
  incrementBillingMetric,
}))

const { subscriptionsRetrieveMock } = vi.hoisted(() => ({ subscriptionsRetrieveMock: vi.fn() }))
vi.mock("../../src/lib/stripe.js", async (importActual) => {
  const actual = await importActual<typeof import("../../src/lib/stripe.js")>()
  return {
    ...actual,
    stripeClient: () => ({ subscriptions: { retrieve: subscriptionsRetrieveMock } }),
  }
})

vi.stubEnv("STRIPE_PRICE_CRAWL_PLUS", "price_growth_test")

const { processStripeWebhookEvent } = await import("../../src/services/billing.service.js")
const { pool } = await import("../../src/lib/db.js")

async function seedUser(label: string): Promise<string> {
  const { rows } = await pool!.query<{ id: string }>(
    `insert into users (email, password_hash, name, email_verified) values ($1, 'x', $2, true) returning id`,
    [`${label}-${randomUUID()}@example.test`, label],
  )
  return rows[0].id
}

async function seedChatbot(userId: string, label: string): Promise<string> {
  const { rows } = await pool!.query<{ id: string }>(
    `insert into chatbots (user_id, name, sources, status) values ($1, $2, '[]', 'ready') returning id`,
    [userId, `${label} bot`],
  )
  return rows[0].id
}

describe("WP-1.8 checkout activation metric", () => {
  it("emits billing.checkout_activated after a paid subscription checkout, not for a top-up", async () => {
    incrementBillingMetric.mockClear()
    const userId = await seedUser("checkout-activated")
    subscriptionsRetrieveMock.mockResolvedValue({
      id: "sub_wp18",
      customer: `cus_${userId}`,
      status: "active",
      metadata: { userId, plan: "crawl_plus" },
      items: {
        data: [{ price: { id: "price_growth_test", unit_amount: 2000, currency: "usd" }, quantity: 1, current_period_end: 1893456000 }],
      },
    })

    await processStripeWebhookEvent({
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_wp18_sub",
          subscription: "sub_wp18",
          amount_total: 2000,
          currency: "usd",
          payment_status: "paid",
          metadata: { userId, plan: "crawl_plus" },
        },
      },
    } as unknown as import("stripe").Stripe.Event)

    expect(incrementBillingMetric).toHaveBeenCalledWith(
      "billing.checkout_activated",
      expect.objectContaining({ userId, plan: "crawl_plus", sessionId: "cs_wp18_sub" }),
    )

    incrementBillingMetric.mockClear()
    const topupUser = await seedUser("checkout-topup")
    const chatbotId = await seedChatbot(topupUser, "checkout-topup")
    await processStripeWebhookEvent({
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_wp18_topup",
          amount_total: 1000,
          currency: "usd",
          payment_status: "paid",
          metadata: {
            topupChatbotId: chatbotId,
            topupModel: "openai",
            topupBillingPeriod: "2026-09",
          },
        },
      },
    } as unknown as import("stripe").Stripe.Event)

    expect(incrementBillingMetric.mock.calls.some((call) => call.at(0) === "billing.checkout_activated")).toBe(false)
  })
})
