import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

// CS-07 / VER-05 (B06-004): concurrent public chat requests that all hit the
// usage cap at once must not each charge the owner's card. Stripe is mocked
// entirely; no network call is made. Requires
// db/migrations/20261114_auto_purchase_daily_claim.sql on the test database.
const { pricesRetrieveMock, paymentMethodsListMock, paymentIntentsCreateMock } = vi.hoisted(() => ({
  pricesRetrieveMock: vi.fn(),
  paymentMethodsListMock: vi.fn(),
  paymentIntentsCreateMock: vi.fn(),
}))
vi.mock("../../src/lib/stripe.js", async (importActual) => {
  const actual = await importActual<typeof import("../../src/lib/stripe.js")>()
  return {
    ...actual,
    stripeClient: () => ({
      prices: { retrieve: pricesRetrieveMock },
      paymentMethods: { list: paymentMethodsListMock },
      paymentIntents: { create: paymentIntentsCreateMock },
    }),
  }
})

// createNotification / creditTopup pass through to the real implementations
// unless a test overrides them with mockImplementationOnce.
const { createNotificationMock, creditTopupMock } = vi.hoisted(() => ({
  createNotificationMock: vi.fn(),
  creditTopupMock: vi.fn(),
}))
vi.mock("../../src/services/notification.service.js", async (importActual) => {
  const actual = await importActual<typeof import("../../src/services/notification.service.js")>()
  createNotificationMock.mockImplementation(actual.createNotification)
  return { ...actual, createNotification: createNotificationMock }
})
vi.mock("../../src/services/topup.service.js", async (importActual) => {
  const actual = await importActual<typeof import("../../src/services/topup.service.js")>()
  creditTopupMock.mockImplementation(actual.creditTopup)
  return { ...actual, creditTopup: creditTopupMock }
})

vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_cs07_dummy")
vi.stubEnv("STRIPE_PRICE_TOPUP_OPENAI", "price_topup_openai_cs07")

const { tryAutoPurchaseTopup } = await import("../../src/services/autoPurchase.service.js")
const { getCreditGrantConfigError, setCreditGrantConfigErrorForTests } = await import("../../src/env.js")
const { pool } = await import("../../src/lib/db.js")
const { createReadyChatbotWithDomain } = await import("../helpers.js")

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function autoPurchaseChatbot(label: string) {
  const { userId, chatbotId } = await createReadyChatbotWithDomain(label, `${label}-${Date.now()}.example.test`)
  await pool!.query("update users set auto_purchase_enabled = true, auto_purchase_model = 'openai' where id = $1", [userId])
  await pool!.query(
    `insert into subscriptions (user_id, stripe_customer_id) values ($1, $2)
     on conflict (user_id) do update set stripe_customer_id = excluded.stripe_customer_id`,
    [userId, `cus_cs07_${userId}`],
  )
  return { userId, chatbotId }
}

describe("tryAutoPurchaseTopup concurrency (CS-07)", () => {
  let savedCreditGrantError: string | null = null

  beforeAll(() => {
    savedCreditGrantError = getCreditGrantConfigError()
    setCreditGrantConfigErrorForTests(null)
  })
  afterAll(() => {
    setCreditGrantConfigErrorForTests(savedCreditGrantError)
  })

  beforeEach(() => {
    pricesRetrieveMock.mockReset()
    paymentMethodsListMock.mockReset()
    paymentIntentsCreateMock.mockReset()
    // Small awaits so concurrent callers genuinely interleave between the
    // "already attempted today?" decision and the charge.
    pricesRetrieveMock.mockImplementation(async () => {
      await sleep(20)
      return { unit_amount: 100000, currency: "usd" }
    })
    paymentMethodsListMock.mockImplementation(async () => {
      await sleep(10)
      return { data: [{ id: "pm_cs07" }] }
    })
  })

  it("N concurrent calls for the same chatbot create exactly one PaymentIntent, with an idempotency key", async () => {
    const { chatbotId } = await autoPurchaseChatbot("cs07-concurrent")
    let n = 0
    paymentIntentsCreateMock.mockImplementation(async (params: { amount: number; currency: string }) => {
      await sleep(30)
      n += 1
      return { id: `pi_cs07_${chatbotId}_${n}`, status: "succeeded", amount: params.amount, currency: params.currency }
    })

    // Warm up enough pool connections that every caller starts at the same
    // point instead of the first one finishing while the rest still connect.
    await Promise.all(Array.from({ length: 10 }, () => pool!.query("select pg_sleep(0.05)")))
    const results = await Promise.all(Array.from({ length: 8 }, () => tryAutoPurchaseTopup(chatbotId)))

    expect(paymentIntentsCreateMock).toHaveBeenCalledTimes(1)
    const [, options] = paymentIntentsCreateMock.mock.calls[0] as [unknown, { idempotencyKey?: string } | undefined]
    const utcDay = new Date().toISOString().slice(0, 10)
    expect(options?.idempotencyKey).toBe(`auto-topup:${chatbotId}:${utcDay}:openai`)
    expect(results.filter(Boolean)).toHaveLength(1)

    const { rows: events } = await pool!.query<{ status: string; claim_day: string | null }>(
      "select status, claim_day::text as claim_day from auto_purchase_events where chatbot_id = $1",
      [chatbotId],
    )
    expect(events).toEqual([{ status: "succeeded", claim_day: utcDay }])
    const { rows: credits } = await pool!.query("select 1 from chatbot_model_credits where chatbot_id = $1", [chatbotId])
    expect(credits).toHaveLength(1)

    // A later call the same UTC day is still blocked by the claim.
    expect(await tryAutoPurchaseTopup(chatbotId)).toBe(false)
    expect(paymentIntentsCreateMock).toHaveBeenCalledTimes(1)
  })

  it("a Stripe error marks the claim failed (not stuck 'attempted') and does not retry the charge the same day", async () => {
    const { chatbotId } = await autoPurchaseChatbot("cs07-stripe-error")
    paymentIntentsCreateMock.mockRejectedValue(new Error("Your card was declined."))

    expect(await tryAutoPurchaseTopup(chatbotId)).toBe(false)
    expect(await tryAutoPurchaseTopup(chatbotId)).toBe(false)

    expect(paymentIntentsCreateMock).toHaveBeenCalledTimes(1)
    const { rows } = await pool!.query<{ status: string; detail: string | null }>(
      "select status, detail from auto_purchase_events where chatbot_id = $1",
      [chatbotId],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe("failed")
    expect(rows[0].detail).toContain("Your card was declined.")
  })

  it("a notification failure after a successful charge keeps the claim 'succeeded' and still returns true", async () => {
    const { chatbotId } = await autoPurchaseChatbot("cs07-notify-error")
    paymentIntentsCreateMock.mockImplementation(async (params: { amount: number; currency: string }) => ({
      id: `pi_cs07_notify_${chatbotId}`,
      status: "succeeded",
      amount: params.amount,
      currency: params.currency,
    }))
    createNotificationMock.mockImplementationOnce(async () => {
      throw new Error("notification store down")
    })

    expect(await tryAutoPurchaseTopup(chatbotId)).toBe(true)

    const { rows } = await pool!.query<{ status: string; detail: string | null }>(
      "select status, detail from auto_purchase_events where chatbot_id = $1",
      [chatbotId],
    )
    expect(rows).toEqual([{ status: "succeeded", detail: `pi_cs07_notify_${chatbotId}` }])
    const { rows: credits } = await pool!.query("select 1 from chatbot_model_credits where chatbot_id = $1", [chatbotId])
    expect(credits).toHaveLength(1)
  })

  it("a credit failure after a successful charge is recorded as 'charged_not_credited' with the PaymentIntent id", async () => {
    const { chatbotId } = await autoPurchaseChatbot("cs07-credit-error")
    const intentId = `pi_cs07_credit_${chatbotId}`
    paymentIntentsCreateMock.mockImplementation(async (params: { amount: number; currency: string }) => ({
      id: intentId,
      status: "succeeded",
      amount: params.amount,
      currency: params.currency,
    }))
    creditTopupMock.mockImplementationOnce(async () => {
      throw new Error("credit insert failed")
    })

    expect(await tryAutoPurchaseTopup(chatbotId)).toBe(false)
    // Still one charge only: the claim keeps blocking the rest of the day.
    expect(await tryAutoPurchaseTopup(chatbotId)).toBe(false)
    expect(paymentIntentsCreateMock).toHaveBeenCalledTimes(1)

    const { rows } = await pool!.query<{ status: string; detail: string | null }>(
      "select status, detail from auto_purchase_events where chatbot_id = $1",
      [chatbotId],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe("charged_not_credited")
    expect(rows[0].detail).toContain(intentId)
    expect(rows[0].detail).toContain("credit insert failed")
  })
})
