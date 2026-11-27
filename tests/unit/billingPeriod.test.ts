import { describe, expect, it } from "vitest"

import {
  addOneBillingPeriod,
  invoiceSubscriptionId,
  periodEndFromStripeSubscription,
  unixSecondsToDate,
} from "../../src/lib/billingPeriod.js"

describe("billing period helpers", () => {
  it("keeps the clock time when adding one calendar month (28 Sep 19:00 → 28 Oct 19:00)", () => {
    const paidAt = new Date("2026-09-28T19:00:00")
    const next = addOneBillingPeriod(paidAt)
    expect(next.getFullYear()).toBe(2026)
    expect(next.getMonth()).toBe(9)
    expect(next.getDate()).toBe(28)
    expect(next.getHours()).toBe(19)
    expect(next.getMinutes()).toBe(0)
  })

  it("reads current_period_end from the subscription item first", () => {
    const ts = Math.floor(new Date("2026-10-28T19:00:00Z").getTime() / 1000)
    const end = periodEndFromStripeSubscription({
      items: { data: [{ current_period_end: ts }] },
    })
    expect(end?.toISOString()).toBe(new Date(ts * 1000).toISOString())
  })

  it("falls back to the subscription-level timestamp used by older Stripe payloads", () => {
    const ts = 1893456000
    expect(unixSecondsToDate(ts)?.getTime()).toBe(ts * 1000)
    expect(periodEndFromStripeSubscription({ current_period_end: ts })?.getTime()).toBe(ts * 1000)
  })

  it("reads the Basil invoice subscription id from parent.subscription_details", () => {
    expect(
      invoiceSubscriptionId({
        parent: { subscription_details: { subscription: "sub_basil" } },
      }),
    ).toBe("sub_basil")
  })
})
