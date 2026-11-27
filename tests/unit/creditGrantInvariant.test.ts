import { afterEach, describe, expect, it } from "vitest"

import {
  env,
  isCreditGrantingEnabled,
  requireCreditGrantingEnabled,
  setCreditGrantConfigErrorForTests,
} from "../../src/env.js"
import { AppError } from "../../src/lib/errors.js"
import {
  CRAWL_PLUS_20,
  CreditGrantInvariantError,
  assertConfiguredGrantsLessThanCash,
  assertGrantLessThanCash,
  cashUsdFromStripeAmount,
  evaluateCreditGrantConfig,
  grantedCreditsFromSale,
  isPaidCheckoutStatus,
  usdFromStripeCents,
} from "../../src/lib/planEconomics.js"
import { processStripeWebhookEvent } from "../../src/services/billing.service.js"
import { creditTopup } from "../../src/services/topup.service.js"
import { updateTenantOverrideSchema } from "../../src/validators/admin.validator.js"

function topupCompletedEvent(overrides: Record<string, unknown> = {}) {
  return {
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_test_topup",
        amount_total: 1000,
        currency: "usd",
        payment_status: "paid",
        metadata: {
          topupChatbotId: "chatbot-id",
          topupModel: "openai",
          topupBillingPeriod: "2026-09",
        },
        ...overrides,
      },
    },
  } as unknown as import("stripe").Stripe.Event
}

describe("grant < cash ledger invariant", () => {
  afterEach(() => {
    setCreditGrantConfigErrorForTests(null)
  })

  it("allows the configured top-up grant only when it is below the configured sale", () => {
    expect(grantedCreditsFromSale(env.topupSaleUsd, CRAWL_PLUS_20.aiBudgetRatio)).toBeLessThan(env.topupSaleUsd)
    expect(env.topupCreditUsd).toBeLessThan(env.topupSaleUsd)
    expect(() => assertGrantLessThanCash(env.topupCreditUsd, env.topupSaleUsd)).not.toThrow()
  })

  it("allows the configured Crawl Plus monthly grant only when it is below the configured sale", () => {
    expect(env.crawlPlusPlanMonthlyCostCapUsd).toBeLessThan(env.crawlPlusSaleUsd)
    expect(() => assertGrantLessThanCash(env.crawlPlusPlanMonthlyCostCapUsd, env.crawlPlusSaleUsd)).not.toThrow()
  })

  it("rejects grant equal to sale", () => {
    expect(() => assertGrantLessThanCash(env.topupSaleUsd, env.topupSaleUsd)).toThrow(CreditGrantInvariantError)
  })

  it("rejects grant greater than sale", () => {
    expect(() => assertGrantLessThanCash(env.topupSaleUsd + 2, env.topupSaleUsd)).toThrow(CreditGrantInvariantError)
  })

  it("rejects missing or zero Stripe amount_total (fail closed)", () => {
    expect(() => assertGrantLessThanCash(env.topupCreditUsd, usdFromStripeCents(undefined))).toThrow(CreditGrantInvariantError)
    expect(() => assertGrantLessThanCash(env.topupCreditUsd, usdFromStripeCents(0))).toThrow(CreditGrantInvariantError)
  })

  it("rejects a Checkout whose cash equals the requested grant", () => {
    const amountTotalUsd = usdFromStripeCents(Math.round(env.topupSaleUsd * 100))
    expect(amountTotalUsd).toBe(env.topupSaleUsd)
    expect(() => assertGrantLessThanCash(env.topupSaleUsd, amountTotalUsd)).toThrow(CreditGrantInvariantError)
  })

  it("creditTopup refuses a grant equal to cash before writing", async () => {
    await expect(
      creditTopup("chatbot-id", "openai", "2026-09", env.topupSaleUsd, "cs_test_equal_grant", env.topupSaleUsd),
    ).rejects.toBeInstanceOf(CreditGrantInvariantError)
  })

  it("webhook fixture: grant equal to Checkout cash is rejected", async () => {
    const equalGrantCents = Math.round(env.topupCreditUsd * 100)
    await expect(
      processStripeWebhookEvent(topupCompletedEvent({ amount_total: equalGrantCents })),
    ).rejects.toBeInstanceOf(CreditGrantInvariantError)
  })

  it("ignores an unpaid Checkout instead of granting credits", async () => {
    await expect(
      processStripeWebhookEvent(topupCompletedEvent({ payment_status: "unpaid" })),
    ).resolves.toBeUndefined()
  })

  it("rejects a partial Checkout payload with missing payment_status", async () => {
    await expect(
      processStripeWebhookEvent(topupCompletedEvent({ payment_status: undefined })),
    ).resolves.toBeUndefined()
  })

  it("rejects non-USD Checkout cash", async () => {
    await expect(processStripeWebhookEvent(topupCompletedEvent({ currency: "jpy" }))).rejects.toBeInstanceOf(
      CreditGrantInvariantError,
    )
  })

  it("rejects invalid configuration where grant is not below configured sale", () => {
    expect(
      evaluateCreditGrantConfig({
        topupCreditUsd: env.topupSaleUsd,
        topupSaleUsd: env.topupSaleUsd,
        crawlPlusMonthlyGrantUsd: env.crawlPlusPlanMonthlyCostCapUsd,
        crawlPlusSaleUsd: env.crawlPlusSaleUsd,
      }),
    ).toMatch(/not less than cash/)
    expect(() =>
      assertConfiguredGrantsLessThanCash({
        topupCreditUsd: env.topupCreditUsd,
        topupSaleUsd: env.topupSaleUsd,
        crawlPlusMonthlyGrantUsd: env.crawlPlusSaleUsd,
        crawlPlusSaleUsd: env.crawlPlusSaleUsd,
      }),
    ).toThrow(CreditGrantInvariantError)
  })

  it("accepts the current configured grants against configured sale prices", () => {
    expect(
      evaluateCreditGrantConfig({
        topupCreditUsd: env.topupCreditUsd,
        topupSaleUsd: env.topupSaleUsd,
        crawlPlusMonthlyGrantUsd: env.crawlPlusPlanMonthlyCostCapUsd,
        crawlPlusSaleUsd: env.crawlPlusSaleUsd,
        fullCustomMonthlyGrantUsd: env.fullCustomPlanMonthlyCostCapUsd,
        fullCustomSaleUsd: env.fullCustomSaleUsd,
      }),
    ).toBeNull()
  })

  it("startup validation disables grants instead of crashing the process", () => {
    expect(isCreditGrantingEnabled()).toBe(true)
    setCreditGrantConfigErrorForTests("Credit grant 10 is not less than cash collected 10.")
    expect(isCreditGrantingEnabled()).toBe(false)
    expect(() => requireCreditGrantingEnabled()).toThrow(AppError)
    expect(() => requireCreditGrantingEnabled()).toThrow(/disabled/)
  })

  it("creditTopup refuses to write when billing grants are disabled", async () => {
    setCreditGrantConfigErrorForTests("invalid configuration")
    await expect(
      creditTopup("chatbot-id", "openai", "2026-09", env.topupCreditUsd, "cs_test_disabled", env.topupSaleUsd),
    ).rejects.toBeInstanceOf(AppError)
  })

  it("treats only paid and no_payment_required as paid Checkout states", () => {
    expect(isPaidCheckoutStatus("paid")).toBe(true)
    expect(isPaidCheckoutStatus("no_payment_required")).toBe(true)
    expect(isPaidCheckoutStatus("unpaid")).toBe(false)
    expect(isPaidCheckoutStatus(undefined)).toBe(false)
  })

  it("converts Stripe cents only for USD", () => {
    expect(cashUsdFromStripeAmount(1000, "usd")).toBe(10)
    expect(() => cashUsdFromStripeAmount(1000, "eur")).toThrow(CreditGrantInvariantError)
  })

  it("requires attested cash when an admin sets a monthly grant", () => {
    expect(updateTenantOverrideSchema.safeParse({ customMonthlyCapUsd: env.crawlPlusPlanMonthlyCostCapUsd }).success).toBe(false)
    expect(
      updateTenantOverrideSchema.safeParse({
        customMonthlyCapUsd: env.crawlPlusPlanMonthlyCostCapUsd,
        cashCollectedUsd: env.crawlPlusSaleUsd,
      }).success,
    ).toBe(true)
  })
})
