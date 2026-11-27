import { describe, expect, it, vi } from "vitest"

// stripeClient() is mocked out entirely — this suite tests OUR webhook
// processing logic (does the right DB row get the right update for each
// event type), not Stripe's own SDK, which we have no reason to
// re-verify. planForPriceId/priceIdForPlan are kept real (via
// importActual) since checkout.session.completed's plan-resolution logic
// is part of what's under test here.
const { subscriptionsRetrieveMock } = vi.hoisted(() => ({ subscriptionsRetrieveMock: vi.fn() }))
vi.mock("../../src/lib/stripe.js", async (importActual) => {
  const actual = await importActual<typeof import("../../src/lib/stripe.js")>()
  return {
    ...actual,
    stripeClient: () => ({ subscriptions: { retrieve: subscriptionsRetrieveMock } }),
  }
})

vi.stubEnv("STRIPE_PRICE_CRAWL_PLUS", "price_growth_test")

const { processStripeWebhookEvent, runBillingLifecycleTick, getEntitlementForChatbot } = await import("../../src/services/billing.service.js")
const { getAccountStatus } = await import("../../src/services/accessGate.service.js")
const { creditTopup } = await import("../../src/services/topup.service.js")
const { env } = await import("../../src/env.js")
const { CreditGrantInvariantError } = await import("../../src/lib/planEconomics.js")
const { addOneBillingPeriod } = await import("../../src/lib/billingPeriod.js")
const { pool } = await import("../../src/lib/db.js")
const { createReadyChatbotWithDomain, signupUser } = await import("../helpers.js")

function fakeEvent(type: string, object: unknown) {
  return { type, data: { object } } as import("stripe").Stripe.Event
}

function fakeSubscription(overrides: Record<string, unknown> = {}) {
  return {
    id: "sub_test_1",
    customer: "cus_test_1",
    status: "active",
    metadata: {},
    items: {
      data: [{ price: { id: "price_growth_test", unit_amount: 2000, currency: "usd" }, quantity: 1, current_period_end: 1893456000 }],
    },
    ...overrides,
  }
}

describe("processStripeWebhookEvent", () => {
  it("checkout.session.completed retrieves the real subscription and creates/updates the subscriptions row for that user", async () => {
    const { user } = await signupUser("billing-checkout")
    subscriptionsRetrieveMock.mockResolvedValue(fakeSubscription({ customer: `cus_${user.id}` }))

    await processStripeWebhookEvent(
      fakeEvent("checkout.session.completed", {
        subscription: "sub_test_1",
        amount_total: 2000,
        currency: "usd",
        payment_status: "paid",
        metadata: { userId: user.id, plan: "crawl_plus" },
      }),
    )

    const { rows } = await pool!.query<{
      plan: string
      status: string
      stripe_customer_id: string
      stripe_subscription_id: string
      current_period_end: Date | null
    }>(
      "select plan, status, stripe_customer_id, stripe_subscription_id, current_period_end from subscriptions where user_id = $1",
      [user.id],
    )
    expect(rows[0]).toMatchObject({
      plan: "crawl_plus",
      status: "active",
      stripe_customer_id: `cus_${user.id}`,
      stripe_subscription_id: "sub_test_1",
    })
    expect(rows[0].current_period_end?.toISOString()).toBe(new Date(1893456000 * 1000).toISOString())
  })

  it("checkout.session.completed still upgrades the plan when Stripe omits item unit_amount", async () => {
    const { user } = await signupUser("billing-checkout-no-unit")
    subscriptionsRetrieveMock.mockResolvedValue(
      fakeSubscription({
        customer: `cus_${user.id}`,
        items: { data: [{ price: { id: "price_growth_test" } }] },
      }),
    )

    await processStripeWebhookEvent(
      fakeEvent("checkout.session.completed", {
        subscription: "sub_test_1",
        amount_total: 2000,
        currency: "usd",
        payment_status: "paid",
        metadata: { userId: user.id, plan: "crawl_plus" },
      }),
    )

    const { rows } = await pool!.query<{ plan: string; status: string; current_period_end: Date | null }>(
      "select plan, status, current_period_end from subscriptions where user_id = $1",
      [user.id],
    )
    expect(rows[0]).toMatchObject({ plan: "crawl_plus", status: "active" })
    const expected = addOneBillingPeriod(new Date())
    expect(rows[0].current_period_end).toBeTruthy()
    expect(Math.abs(rows[0].current_period_end!.getTime() - expected.getTime())).toBeLessThan(15_000)
  })

  it("invoice.paid activates Crawl Plus from Basil parent.subscription_details", async () => {
    const { user } = await signupUser("billing-invoice-paid")
    const customerId = `cus_${user.id}`
    await pool!.query(
      `insert into subscriptions (user_id, stripe_customer_id, plan, status) values ($1, $2, 'free', 'inactive')`,
      [user.id, customerId],
    )
    subscriptionsRetrieveMock.mockResolvedValue(fakeSubscription({ customer: customerId, metadata: { userId: user.id, plan: "crawl_plus" } }))

    await processStripeWebhookEvent(
      fakeEvent("invoice.paid", {
        id: "in_test_paid",
        customer: customerId,
        amount_paid: 2000,
        currency: "usd",
        billing_reason: "subscription_create",
        parent: { subscription_details: { subscription: "sub_test_1" } },
      }),
    )

    const { rows } = await pool!.query("select plan, status from subscriptions where user_id = $1", [user.id])
    expect(rows[0]).toMatchObject({ plan: "crawl_plus", status: "active" })
  })

  it("customer.subscription.updated updates the existing row by stripe_customer_id, not by userId", async () => {
    const { user } = await signupUser("billing-updated")
    const customerId = `cus_${user.id}`
    await pool!.query(
      `insert into subscriptions (user_id, stripe_customer_id, plan, status) values ($1, $2, 'free', 'inactive')`,
      [user.id, customerId],
    )

    const subscription = fakeSubscription({ customer: customerId, status: "past_due" })
    subscriptionsRetrieveMock.mockResolvedValueOnce(subscription)
    await processStripeWebhookEvent(fakeEvent("customer.subscription.updated", subscription))

    const { rows } = await pool!.query("select plan, status from subscriptions where stripe_customer_id = $1", [customerId])
    expect(rows[0]).toMatchObject({ plan: "crawl_plus", status: "past_due" })
  })

  it("customer.subscription.deleted marks the row canceled", async () => {
    const { user } = await signupUser("billing-deleted")
    const customerId = `cus_${user.id}`
    await pool!.query(
      `insert into subscriptions (user_id, stripe_customer_id, plan, status) values ($1, $2, 'crawl_plus', 'active')`,
      [user.id, customerId],
    )

    const subscription = fakeSubscription({ customer: customerId, status: "canceled" })
    subscriptionsRetrieveMock.mockResolvedValueOnce(subscription)
    await processStripeWebhookEvent(fakeEvent("customer.subscription.deleted", subscription))

    const { rows } = await pool!.query("select status from subscriptions where stripe_customer_id = $1", [customerId])
    expect(rows[0].status).toBe("canceled")
  })

  it("invoice.payment_failed marks the row past_due without touching plan", async () => {
    const { user } = await signupUser("billing-invoice-failed")
    const customerId = `cus_${user.id}`
    // CS-13: the failed invoice must belong to the subscription the row holds.
    await pool!.query(
      `insert into subscriptions (user_id, stripe_customer_id, stripe_subscription_id, plan, status) values ($1, $2, 'sub_test_1', 'crawl_plus', 'active')`,
      [user.id, customerId],
    )

    await processStripeWebhookEvent(fakeEvent("invoice.payment_failed", { customer: customerId, subscription: "sub_test_1" }))

    const { rows } = await pool!.query("select plan, status from subscriptions where stripe_customer_id = $1", [customerId])
    expect(rows[0]).toMatchObject({ plan: "crawl_plus", status: "past_due" })
  })

  it("an unrecognized event type is a no-op, not an error", async () => {
    await expect(processStripeWebhookEvent(fakeEvent("customer.updated", {}))).resolves.toBeUndefined()
  })

  it("an entitled subscription.updated without a priced item fails closed", async () => {
    const { user } = await signupUser("billing-missing-price")
    const customerId = `cus_${user.id}`
    await pool!.query(
      `insert into subscriptions (user_id, stripe_customer_id, plan, status) values ($1, $2, 'free', 'inactive')`,
      [user.id, customerId],
    )

    const unpriced = fakeSubscription({
      customer: customerId,
      items: { data: [{ price: { id: "price_growth_test" }, current_period_end: 1893456000 }] },
    })
    subscriptionsRetrieveMock.mockResolvedValueOnce(unpriced)
    await expect(
      processStripeWebhookEvent(fakeEvent("customer.subscription.updated", unpriced)),
    ).rejects.toBeInstanceOf(CreditGrantInvariantError)

    const { rows } = await pool!.query("select plan, status from subscriptions where stripe_customer_id = $1", [customerId])
    expect(rows[0]).toMatchObject({ plan: "free", status: "inactive" })
  })

  it("duplicate and concurrent top-up credits write a single row (retry-safe)", async () => {
    const { chatbotId } = await createReadyChatbotWithDomain(
      "billing-topup-idempotent",
      `billing-topup-idempotent-${Date.now()}.test`,
    )
    const sessionId = `cs_test_idempotent_${chatbotId}`

    await Promise.all([
      creditTopup(chatbotId, "openai", "2026-09", env.topupCreditUsd, sessionId, env.topupSaleUsd),
      creditTopup(chatbotId, "openai", "2026-09", env.topupCreditUsd, sessionId, env.topupSaleUsd),
    ])
    await creditTopup(chatbotId, "openai", "2026-09", env.topupCreditUsd, sessionId, env.topupSaleUsd)

    const { rows } = await pool!.query<{ credited_usd: string }>(
      "select credited_usd from chatbot_model_credits where stripe_checkout_session_id = $1",
      [sessionId],
    )
    expect(rows).toHaveLength(1)
    expect(Number(rows[0].credited_usd)).toBe(env.topupCreditUsd)
    expect(Number(rows[0].credited_usd)).toBeLessThan(env.topupSaleUsd)
  })

  it("holds an expired Crawl Plus row, keeps the plan, and uses free features until payment", async () => {
    const { userId, chatbotId } = await createReadyChatbotWithDomain(
      "billing-hold",
      `billing-hold-${Date.now()}.test`,
    )
    const periodEnd = new Date(Date.now() - 60_000)
    await pool!.query(
      `insert into subscriptions (user_id, stripe_customer_id, plan, status, current_period_end)
       values ($1, $2, 'crawl_plus', 'active', $3)`,
      [userId, `cus_hold_${userId}`, periodEnd],
    )

    const first = await runBillingLifecycleTick()
    expect(first.held).toBeGreaterThanOrEqual(1)

    const { rows } = await pool!.query<{ plan: string; status: string }>(
      "select plan, status from subscriptions where user_id = $1",
      [userId],
    )
    expect(rows[0]).toMatchObject({ plan: "crawl_plus", status: "unpaid" })

    const account = await getAccountStatus(userId, chatbotId)
    expect(account).toMatchObject({ plan: "crawl_plus", planActive: false, onHold: true })

    const entitlement = await getEntitlementForChatbot(chatbotId)
    expect(entitlement.plan).toBe("free")
    expect(entitlement.active).toBe(false)

    await runBillingLifecycleTick()

    const { rows: notices } = await pool!.query<{ n: string }>(
      `select count(*)::text as n from notifications
        where user_id = $1 and metadata->>'kind' = 'plan_hold'`,
      [userId],
    )
    expect(Number(notices[0].n)).toBe(1)
  })

  // 2026-09-29 audit finding: the per-row notice lookup inside this tick's
  // loop was replaced with one batched query per loop (existingNoticeKeys).
  // The existing single-user tests above can't tell a correct batch query
  // apart from one that accidentally cross-contaminates between users in
  // the same tick (e.g. a key built without the periodEnd, or without the
  // userId) — this test seeds two users due in the same tick specifically
  // to catch that class of bug.
  it("notifies each of several users due in the same tick exactly once, without cross-contamination", async () => {
    const { userId: userA, chatbotId: chatbotIdA } = await createReadyChatbotWithDomain(
      "billing-hold-batch-a",
      `billing-hold-batch-a-${Date.now()}.test`,
    )
    const { userId: userB } = await createReadyChatbotWithDomain(
      "billing-hold-batch-b",
      `billing-hold-batch-b-${Date.now()}.test`,
    )
    const periodEndA = new Date(Date.now() - 60_000)
    const periodEndB = new Date(Date.now() - 120_000)
    await pool!.query(
      `insert into subscriptions (user_id, stripe_customer_id, plan, status, current_period_end)
       values ($1, $2, 'crawl_plus', 'active', $3)`,
      [userA, `cus_hold_batch_a_${userA}`, periodEndA],
    )
    await pool!.query(
      `insert into subscriptions (user_id, stripe_customer_id, plan, status, current_period_end)
       values ($1, $2, 'full_custom', 'active', $3)`,
      [userB, `cus_hold_batch_b_${userB}`, periodEndB],
    )

    await runBillingLifecycleTick()
    await runBillingLifecycleTick()

    const { rows: countsA } = await pool!.query<{ n: string }>(
      `select count(*)::text as n from notifications where user_id = $1 and metadata->>'kind' = 'plan_hold'`,
      [userA],
    )
    const { rows: countsB } = await pool!.query<{ n: string }>(
      `select count(*)::text as n from notifications where user_id = $1 and metadata->>'kind' = 'plan_hold'`,
      [userB],
    )
    expect(Number(countsA[0].n)).toBe(1)
    expect(Number(countsB[0].n)).toBe(1)

    const { rows: subA } = await pool!.query<{ status: string }>("select status from subscriptions where user_id = $1", [userA])
    const { rows: subB } = await pool!.query<{ status: string }>("select status from subscriptions where user_id = $1", [userB])
    expect(subA[0].status).toBe("unpaid")
    expect(subB[0].status).toBe("unpaid")

    const entitlementA = await getEntitlementForChatbot(chatbotIdA)
    expect(entitlementA.plan).toBe("free")
  })

  it("sends one renewal reminder when the next billing date is 2–5 days away", async () => {
    const { user } = await signupUser("billing-renewal-alert")
    const periodEnd = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000)
    await pool!.query(
      `insert into subscriptions (user_id, stripe_customer_id, plan, status, current_period_end)
       values ($1, $2, 'crawl_plus', 'active', $3)`,
      [user.id, `cus_renew_${user.id}`, periodEnd],
    )

    const first = await runBillingLifecycleTick()
    expect(first.reminded).toBeGreaterThanOrEqual(1)
    await runBillingLifecycleTick()

    const { rows } = await pool!.query<{ n: string }>(
      `select count(*)::text as n from notifications
        where user_id = $1 and metadata->>'kind' = 'renewal_reminder'`,
      [user.id],
    )
    expect(Number(rows[0].n)).toBe(1)
  })
})
