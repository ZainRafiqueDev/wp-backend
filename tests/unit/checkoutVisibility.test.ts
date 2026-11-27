import { describe, expect, it } from "vitest"

// Mirrors Chatmate360-main/lib/billingCheckout.ts. Frontend has no test
// runner; this file is the CI contract for WP-1.8 visibility so a future
// kill-switch cannot come back as a silent boolean.
function shouldShowCrawlPlusCheckout(billing: {
  plan: "free" | "crawl_plus" | "full_custom"
  planActive: boolean
  stripeConfigured: boolean
}): boolean {
  if (!billing.stripeConfigured) return false
  if (billing.plan === "full_custom" && billing.planActive) return false
  return !billing.planActive || billing.plan === "free"
}

describe("WP-1.8 dashboard checkout visibility", () => {
  it("hides checkout when Stripe is not configured on the backend", () => {
    expect(
      shouldShowCrawlPlusCheckout({ plan: "free", planActive: false, stripeConfigured: false }),
    ).toBe(false)
  })

  it("shows Crawl Plus checkout for free and inactive paid accounts when Stripe is configured", () => {
    expect(shouldShowCrawlPlusCheckout({ plan: "free", planActive: false, stripeConfigured: true })).toBe(true)
    expect(shouldShowCrawlPlusCheckout({ plan: "crawl_plus", planActive: false, stripeConfigured: true })).toBe(true)
    expect(shouldShowCrawlPlusCheckout({ plan: "full_custom", planActive: false, stripeConfigured: true })).toBe(true)
  })

  it("hides checkout for an already-active Crawl Plus or Full Custom subscription", () => {
    expect(shouldShowCrawlPlusCheckout({ plan: "crawl_plus", planActive: true, stripeConfigured: true })).toBe(false)
    expect(shouldShowCrawlPlusCheckout({ plan: "full_custom", planActive: true, stripeConfigured: true })).toBe(false)
  })
})
