import { randomUUID } from "node:crypto"
import request from "supertest"
import { beforeEach, describe, expect, it, vi } from "vitest"

// CS-13 regression tests (B06-005, B06-006, B06-007, unpaid status, Stripe
// idempotency keys). Stripe is always mocked; nothing here reaches the
// network. Each test fails on the pre-CS-13 code.
const stripeMock = vi.hoisted(() => ({
  subscriptionsRetrieve: vi.fn(),
  subscriptionsCancel: vi.fn(),
  customersCreate: vi.fn(),
  checkoutCreate: vi.fn(),
  checkoutList: vi.fn(),
  checkoutExpire: vi.fn(),
  portalCreate: vi.fn(),
}))
vi.mock("../../src/lib/stripe.js", async (importActual) => {
  const actual = await importActual<typeof import("../../src/lib/stripe.js")>()
  return {
    ...actual,
    stripeClient: () => ({
      subscriptions: { retrieve: stripeMock.subscriptionsRetrieve, cancel: stripeMock.subscriptionsCancel },
      customers: { create: stripeMock.customersCreate },
      checkout: { sessions: { create: stripeMock.checkoutCreate, list: stripeMock.checkoutList, expire: stripeMock.checkoutExpire } },
      billingPortal: { sessions: { create: stripeMock.portalCreate } },
    }),
  }
})

vi.stubEnv("STRIPE_PRICE_CRAWL_PLUS", "price_growth_test")
vi.stubEnv("STRIPE_PRICE_FULL_CUSTOM", "price_full_custom_test")
// Dummy values so hasStripe is true and the admin paths call (mocked) Stripe.
vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_dummy_cs13")
vi.stubEnv("STRIPE_WEBHOOK_SECRET", "whsec_dummy_cs13")

const { processStripeWebhookEvent, createCheckoutSession, createBillingPortalSession, getOrCreateStripeCustomer } = await import(
  "../../src/services/billing.service.js"
)
const { cancelUserSubscription, activateUserPlan } = await import("../../src/services/admin/adminPlans.service.js")
const { deleteUser } = await import("../../src/services/admin/adminUsers.service.js")
const { currentBillingPeriod } = await import("../../src/services/usage.service.js")
const { hashPassword } = await import("../../src/lib/auth.js")
const { pool } = await import("../../src/lib/db.js")
const { app, cookieValue, createReadyChatbotWithDomain, signupUser, uniqueEmail } = await import("../helpers.js")

function fakeEvent(type: string, object: unknown) {
  return { id: `evt_${randomUUID()}`, type, data: { object } } as unknown as import("stripe").Stripe.Event
}

function fakeSubscription(overrides: Record<string, unknown> = {}) {
  return {
    id: "sub_cs13",
    customer: "cus_cs13",
    status: "active",
    metadata: {},
    items: {
      data: [{ price: { id: "price_growth_test", unit_amount: 2000, currency: "usd" }, quantity: 1, current_period_end: 1893456000 }],
    },
    ...overrides,
  }
}

async function seedSubscription(userId: string, fields: { customerId: string; subscriptionId: string | null; plan: string; status: string }) {
  await pool!.query(
    `insert into subscriptions (user_id, stripe_customer_id, stripe_subscription_id, plan, status) values ($1, $2, $3, $4, $5)`,
    [userId, fields.customerId, fields.subscriptionId, fields.plan, fields.status],
  )
}

async function subscriptionRow(userId: string) {
  const { rows } = await pool!.query<{ plan: string; status: string; stripe_customer_id: string; stripe_subscription_id: string | null }>(
    "select plan, status, stripe_customer_id, stripe_subscription_id from subscriptions where user_id = $1",
    [userId],
  )
  return rows[0]
}

async function createAdmin(label: string) {
  const email = uniqueEmail(label)
  const password = "a very strong admin password"
  await pool!.query(// SA-02: these tests exercise super-admin-only actions (plans, delete).
    "insert into admin_users (email, password_hash, name, role) values ($1, $2, $3, 'super_admin')", [email, await hashPassword(password), "CS13 Admin"])
  const login = await request(app).post("/admin/login").send({ email, password })
  if (login.status !== 200) throw new Error(`createAdmin failed: ${login.status}`)
  // CS-11: the admin token is only in the httpOnly cookie now.
  return cookieValue(login, "chatmate360_admin_token")
}

/** A stateful fake of Stripe Checkout sessions: create opens one, list returns open ones, expire closes one. */
function fakeCheckoutStore() {
  const sessions: { id: string; customer: string; mode: string; status: string; url: string; metadata: Record<string, string> }[] = []
  stripeMock.checkoutCreate.mockImplementation(async (params: { customer: string; mode: string; metadata: Record<string, string> }) => {
    await new Promise((r) => setTimeout(r, 30))
    const id = `cs_fake_${sessions.length + 1}_${randomUUID()}`
    const session = { id, customer: params.customer, mode: params.mode, status: "open", url: `https://checkout.stripe.test/${id}`, metadata: params.metadata }
    sessions.push(session)
    return session
  })
  stripeMock.checkoutList.mockImplementation(async (params: { customer: string; status: string }) => ({
    data: sessions.filter((x) => x.customer === params.customer && x.status === params.status),
  }))
  stripeMock.checkoutExpire.mockImplementation(async (id: string) => {
    const session = sessions.find((x) => x.id === id)
    if (session) session.status = "expired"
    return session
  })
  return sessions
}

beforeEach(() => {
  for (const fn of Object.values(stripeMock)) fn.mockReset()
  stripeMock.checkoutList.mockResolvedValue({ data: [] })
})

describe("CS-13 B06-005: out-of-order / stale subscription events", () => {
  it("a stale replayed updated(active) after deleted does not re-grant the plan", async () => {
    const { user } = await signupUser("cs13-stale-updated")
    const customerId = `cus_${user.id}`
    await seedSubscription(user.id, { customerId, subscriptionId: "sub_cs13", plan: "crawl_plus", status: "active" })

    // deleted arrives first; Stripe's current state is canceled from now on.
    stripeMock.subscriptionsRetrieve.mockResolvedValue(fakeSubscription({ customer: customerId, status: "canceled" }))
    await processStripeWebhookEvent(fakeEvent("customer.subscription.deleted", fakeSubscription({ customer: customerId, status: "canceled" })))
    expect((await subscriptionRow(user.id))?.status).toBe("canceled")

    // An older updated(active) event is retried afterwards.
    await processStripeWebhookEvent(fakeEvent("customer.subscription.updated", fakeSubscription({ customer: customerId, status: "active" })))
    expect((await subscriptionRow(user.id))?.status).toBe("canceled")
  })

  it("a late deleted / payment_failed for a replaced subscription does not put the current one on hold", async () => {
    const { user } = await signupUser("cs13-other-sub")
    const customerId = `cus_${user.id}`
    await seedSubscription(user.id, { customerId, subscriptionId: "sub_current", plan: "crawl_plus", status: "active" })

    const old = fakeSubscription({ id: "sub_old", customer: customerId, status: "canceled" })
    stripeMock.subscriptionsRetrieve.mockResolvedValue(old)
    await processStripeWebhookEvent(fakeEvent("customer.subscription.deleted", old))
    await processStripeWebhookEvent(fakeEvent("invoice.payment_failed", { customer: customerId, subscription: "sub_old" }))

    expect(await subscriptionRow(user.id)).toMatchObject({ status: "active", stripe_subscription_id: "sub_current" })
  })

  it("a webhook for the subscription replaced by admin Full Custom activation cannot clobber Full Custom", async () => {
    const adminToken = await createAdmin("cs13-activate-clobber")
    const { user } = await signupUser("cs13-activate-clobber-target")
    const customerId = `cus_${user.id}`
    await seedSubscription(user.id, { customerId, subscriptionId: "sub_prior", plan: "crawl_plus", status: "active" })
    stripeMock.subscriptionsCancel.mockResolvedValue({ id: "sub_prior", status: "canceled" })

    await activateUserPlan(adminToken, user.id, {
      plan: "full_custom",
      monthlyCreditUsd: 40,
      cashCollectedUsd: 100,
      allowedModels: ["openai", "anthropic"],
    } as Parameters<typeof activateUserPlan>[2])
    expect(await subscriptionRow(user.id)).toMatchObject({ plan: "full_custom", status: "active", stripe_customer_id: customerId })

    const prior = fakeSubscription({ id: "sub_prior", customer: customerId, status: "canceled" })
    stripeMock.subscriptionsRetrieve.mockResolvedValue(prior)
    await processStripeWebhookEvent(fakeEvent("customer.subscription.deleted", prior))
    await processStripeWebhookEvent(fakeEvent("invoice.payment_failed", { customer: customerId, subscription: "sub_prior" }))

    expect(await subscriptionRow(user.id)).toMatchObject({ plan: "full_custom", status: "active" })
  })

  it("a second checkout is refused while the user holds an active paid subscription", async () => {
    const { user, session } = await signupUser("cs13-double-checkout")
    await seedSubscription(user.id, { customerId: `cus_${user.id}`, subscriptionId: "sub_cs13", plan: "crawl_plus", status: "active" })
    stripeMock.checkoutCreate.mockResolvedValue({ id: "cs_x", url: "https://checkout.stripe.test/x" })

    await expect(createCheckoutSession(session.access_token, { plan: "crawl_plus" })).rejects.toMatchObject({ status: 409 })
    expect(stripeMock.checkoutCreate).not.toHaveBeenCalled()
  })
})

describe("CS-13: Stripe idempotency keys and the customer race (B06-007)", () => {
  it("passes an idempotency key on customer, checkout and portal create calls", async () => {
    const { user, session } = await signupUser("cs13-idem-keys")
    stripeMock.customersCreate.mockResolvedValue({ id: `cus_idem_${user.id}` })
    stripeMock.checkoutCreate.mockResolvedValue({ id: "cs_idem", url: "https://checkout.stripe.test/idem" })
    stripeMock.portalCreate.mockResolvedValue({ id: "bps_idem", url: "https://billing.stripe.test/idem" })

    await createCheckoutSession(session.access_token, { plan: "crawl_plus" })
    await createBillingPortalSession(session.access_token)

    expect(stripeMock.customersCreate.mock.calls[0]?.[1]).toMatchObject({ idempotencyKey: `cm360:customer:${user.id}` })
    expect(stripeMock.checkoutCreate.mock.calls[0]?.[1]?.idempotencyKey).toMatch(new RegExp(`^cm360:checkout:${user.id}:crawl_plus:\\d+$`))
    expect(stripeMock.portalCreate.mock.calls[0]?.[1]?.idempotencyKey).toMatch(new RegExp(`^cm360:portal:${user.id}:\\d+$`))
  })

  it("concurrent getOrCreateStripeCustomer calls all return the one stored customer id", async () => {
    const { user } = await signupUser("cs13-customer-race")
    let n = 0
    stripeMock.customersCreate.mockImplementation(async () => {
      const k = ++n
      await new Promise((r) => setTimeout(r, 20))
      return { id: `cus_race_${k}_${user.id}` }
    })

    const ids = await Promise.all([getOrCreateStripeCustomer(user.id), getOrCreateStripeCustomer(user.id), getOrCreateStripeCustomer(user.id)])
    const stored = (await subscriptionRow(user.id))?.stripe_customer_id
    expect(new Set(ids).size).toBe(1)
    expect(ids[0]).toBe(stored)
  })
})

describe("CS-13: payment status is validated before credits are granted", () => {
  it("a top-up checkout with payment_status 'no_payment_required' grants no credits", async () => {
    const { chatbotId } = await createReadyChatbotWithDomain("cs13-topup-unpaid", `cs13-topup-unpaid-${Date.now()}.test`)
    const sessionId = `cs_${randomUUID()}`
    await expect(
      processStripeWebhookEvent(
        fakeEvent("checkout.session.completed", {
          id: sessionId,
          payment_status: "no_payment_required",
          amount_total: 0,
          currency: "usd",
          metadata: { topupChatbotId: chatbotId, topupModel: "openai", topupBillingPeriod: currentBillingPeriod() },
        }),
      ),
    ).resolves.toBeUndefined()
    const { rows } = await pool!.query("select count(*)::int as n from chatbot_model_credits where stripe_checkout_session_id = $1", [sessionId])
    expect(rows[0].n).toBe(0)
  })

  it("an unpaid subscription checkout does not grant the plan", async () => {
    const { user } = await signupUser("cs13-unpaid-checkout")
    stripeMock.subscriptionsRetrieve.mockResolvedValue(fakeSubscription({ customer: `cus_${user.id}` }))
    await processStripeWebhookEvent(
      fakeEvent("checkout.session.completed", {
        id: `cs_${randomUUID()}`,
        subscription: "sub_cs13",
        payment_status: "unpaid",
        amount_total: 2000,
        currency: "usd",
        metadata: { userId: user.id, plan: "crawl_plus" },
      }),
    )
    expect(await subscriptionRow(user.id)).toBeUndefined()
    expect(stripeMock.subscriptionsRetrieve).not.toHaveBeenCalled()
  })
})

describe("CS-13 B06-006: admin actions fail when Stripe does not confirm the cancel", () => {
  const stripeDown = Object.assign(new Error("Stripe API unavailable"), { statusCode: 500, code: "api_error" })

  it("cancelUserSubscription errors and leaves the local subscription active", async () => {
    const adminToken = await createAdmin("cs13-cancel-fail")
    const { user } = await signupUser("cs13-cancel-fail-target")
    await seedSubscription(user.id, { customerId: `cus_${user.id}`, subscriptionId: "sub_cancel_fail", plan: "crawl_plus", status: "active" })
    stripeMock.subscriptionsCancel.mockRejectedValue(stripeDown)

    await expect(cancelUserSubscription(adminToken, user.id)).rejects.toMatchObject({ status: 502 })
    expect(await subscriptionRow(user.id)).toMatchObject({ status: "active", stripe_subscription_id: "sub_cancel_fail" })
  })

  it("activateUserPlan errors and leaves the existing Stripe subscription linked", async () => {
    const adminToken = await createAdmin("cs13-activate-fail")
    const { user } = await signupUser("cs13-activate-fail-target")
    await seedSubscription(user.id, { customerId: `cus_${user.id}`, subscriptionId: "sub_activate_fail", plan: "crawl_plus", status: "active" })
    stripeMock.subscriptionsCancel.mockRejectedValue(stripeDown)

    await expect(
      activateUserPlan(adminToken, user.id, {
        plan: "full_custom",
        monthlyCreditUsd: 40,
        cashCollectedUsd: 100,
        allowedModels: ["openai"],
      } as Parameters<typeof activateUserPlan>[2]),
    ).rejects.toMatchObject({ status: 502 })
    expect(await subscriptionRow(user.id)).toMatchObject({
      plan: "crawl_plus",
      stripe_customer_id: `cus_${user.id}`,
      stripe_subscription_id: "sub_activate_fail",
    })
  })

  it("deleteUser cancels the Stripe subscription first and keeps the user if that fails", async () => {
    const adminToken = await createAdmin("cs13-delete")
    const { user } = await signupUser("cs13-delete-fail-target")
    await seedSubscription(user.id, { customerId: `cus_${user.id}`, subscriptionId: "sub_delete_fail", plan: "crawl_plus", status: "active" })
    stripeMock.subscriptionsCancel.mockRejectedValue(stripeDown)
    await expect(deleteUser(adminToken, user.id, true)).rejects.toMatchObject({ status: 502 })
    const still = await pool!.query("select id from users where id = $1", [user.id])
    expect(still.rows).toHaveLength(1)

    const { user: other } = await signupUser("cs13-delete-ok-target")
    await seedSubscription(other.id, { customerId: `cus_${other.id}`, subscriptionId: "sub_delete_ok", plan: "crawl_plus", status: "active" })
    stripeMock.subscriptionsCancel.mockReset().mockResolvedValue({ id: "sub_delete_ok", status: "canceled" })
    await deleteUser(adminToken, other.id, true)
    expect(stripeMock.subscriptionsCancel).toHaveBeenCalledWith("sub_delete_ok")
    const gone = await pool!.query("select id from users where id = $1", [other.id])
    expect(gone.rows).toHaveLength(0)
  })
})

describe("CS-13 review: a locally canceled row with a Stripe subscription id is still canceled at Stripe", () => {
  it("activateUserPlan calls Stripe cancel even when the local row says canceled, and treats 'already canceled' as success", async () => {
    const adminToken = await createAdmin("cs13-local-canceled")
    const { user } = await signupUser("cs13-local-canceled-target")
    await seedSubscription(user.id, { customerId: `cus_${user.id}`, subscriptionId: "sub_local_canceled", plan: "crawl_plus", status: "canceled" })
    stripeMock.subscriptionsCancel.mockRejectedValue(
      Object.assign(new Error("A canceled subscription can only update its cancellation_details and metadata."), {
        statusCode: 400,
        code: undefined,
      }),
    )
    stripeMock.subscriptionsRetrieve.mockResolvedValue(fakeSubscription({ id: "sub_local_canceled", customer: `cus_${user.id}`, status: "canceled" }))

    await activateUserPlan(adminToken, user.id, {
      plan: "full_custom",
      monthlyCreditUsd: 40,
      cashCollectedUsd: 100,
      allowedModels: ["openai"],
    } as Parameters<typeof activateUserPlan>[2])

    expect(stripeMock.subscriptionsCancel).toHaveBeenCalledWith("sub_local_canceled")
    expect(await subscriptionRow(user.id)).toMatchObject({ plan: "full_custom", status: "active" })
  })

  it("an active subscription at Stripe behind a locally canceled row blocks activation when the cancel fails", async () => {
    const adminToken = await createAdmin("cs13-local-canceled-live")
    const { user } = await signupUser("cs13-local-canceled-live-target")
    await seedSubscription(user.id, { customerId: `cus_${user.id}`, subscriptionId: "sub_still_live", plan: "crawl_plus", status: "canceled" })
    stripeMock.subscriptionsCancel.mockRejectedValue(Object.assign(new Error("Stripe API unavailable"), { statusCode: 500 }))
    stripeMock.subscriptionsRetrieve.mockResolvedValue(fakeSubscription({ id: "sub_still_live", customer: `cus_${user.id}`, status: "active" }))

    await expect(
      activateUserPlan(adminToken, user.id, {
        plan: "full_custom",
        monthlyCreditUsd: 40,
        cashCollectedUsd: 100,
        allowedModels: ["openai"],
      } as Parameters<typeof activateUserPlan>[2]),
    ).rejects.toMatchObject({ status: 502 })
    expect(await subscriptionRow(user.id)).toMatchObject({ plan: "crawl_plus", stripe_subscription_id: "sub_still_live" })
  })
})

describe("CS-13 review: concurrent checkout requests open at most one Checkout session", () => {
  it("concurrent requests for the same plan create one session; the others get its URL or 409", async () => {
    const { user, session } = await signupUser("cs13-checkout-race-same")
    stripeMock.customersCreate.mockResolvedValue({ id: `cus_race_${user.id}` })
    const sessions = fakeCheckoutStore()

    const results = await Promise.allSettled([
      createCheckoutSession(session.access_token, { plan: "crawl_plus" }),
      createCheckoutSession(session.access_token, { plan: "crawl_plus" }),
      createCheckoutSession(session.access_token, { plan: "crawl_plus" }),
    ])

    expect(stripeMock.checkoutCreate).toHaveBeenCalledTimes(1)
    const urls = results.flatMap((r) => (r.status === "fulfilled" ? [r.value.url] : []))
    expect(urls.length).toBeGreaterThanOrEqual(1)
    expect(new Set(urls).size).toBe(1)
    for (const r of results) if (r.status === "rejected") expect(r.reason).toMatchObject({ status: 409 })
    // A retry after the race reuses the one open session.
    expect((await createCheckoutSession(session.access_token, { plan: "crawl_plus" })).url).toBe(urls[0])
    expect(sessions.filter((x) => x.status === "open")).toHaveLength(1)
  })

  it("two different plans racing leave exactly one open session", async () => {
    const { user, session } = await signupUser("cs13-checkout-race-plans")
    stripeMock.customersCreate.mockResolvedValue({ id: `cus_race_plans_${user.id}` })
    const sessions = fakeCheckoutStore()

    await Promise.allSettled([
      createCheckoutSession(session.access_token, { plan: "crawl_plus" }),
      // The route validator currently only accepts crawl_plus; the service
      // must still be race-safe if another plan is offered later.
      createCheckoutSession(session.access_token, { plan: "full_custom" } as unknown as Parameters<typeof createCheckoutSession>[1]),
    ])

    expect(sessions.filter((x) => x.status === "open")).toHaveLength(1)
  })
})

describe("CS-13 review: checkout lock is tried, not waited on", () => {
  it("a second checkout while the first holds the lock gets 409 quickly", async () => {
    const { user, session } = await signupUser("cs13-checkout-lock-busy")
    stripeMock.customersCreate.mockResolvedValue({ id: `cus_lock_${user.id}` })
    let release!: () => void
    const released = new Promise<void>((r) => { release = r })
    let createStarted!: () => void
    const started = new Promise<void>((r) => { createStarted = r })
    stripeMock.checkoutCreate.mockImplementation(async () => {
      createStarted()
      await released
      return { id: "cs_lock_holder", url: "https://checkout.stripe.test/lock-holder" }
    })

    const first = createCheckoutSession(session.access_token, { plan: "crawl_plus" })
    await started

    const startedAt = Date.now()
    const second = await Promise.race([
      createCheckoutSession(session.access_token, { plan: "crawl_plus" }).then(
        () => "resolved",
        (err: unknown) => err,
      ),
      new Promise((r) => setTimeout(() => r("still waiting"), 2000)),
    ])
    expect(second).toMatchObject({ status: 409 })
    expect(Date.now() - startedAt).toBeLessThan(2000)

    release()
    await expect(first).resolves.toEqual({ url: "https://checkout.stripe.test/lock-holder" })
  })

  it("passes a short timeout and at most one retry on the checkout-path Stripe calls", async () => {
    const { user, session } = await signupUser("cs13-checkout-timeouts")
    stripeMock.customersCreate.mockResolvedValue({ id: `cus_timeouts_${user.id}` })
    stripeMock.checkoutCreate.mockResolvedValue({ id: "cs_t", url: "https://checkout.stripe.test/t" })
    await createCheckoutSession(session.access_token, { plan: "crawl_plus" })
    for (const call of [stripeMock.checkoutList.mock.calls[0]?.[1], stripeMock.checkoutCreate.mock.calls[0]?.[1], stripeMock.customersCreate.mock.calls[0]?.[1]]) {
      expect(call).toMatchObject({ timeout: 10_000, maxNetworkRetries: 1 })
    }
  })
})
