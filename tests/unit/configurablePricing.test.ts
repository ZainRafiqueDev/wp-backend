import { describe, expect, it } from "vitest"

import { computeConfigurablePricing, CreditGrantInvariantError } from "../../src/lib/planEconomics.js"

describe("WP-4.4 configurable pricing engine", () => {
  it("computes $20 Crawl Plus credits strictly below the sale price", () => {
    const result = computeConfigurablePricing({ priceUsd: 20 })
    expect(result.computedAiCreditsUsd).toBeGreaterThan(0)
    expect(result.computedAiCreditsUsd).toBeLessThan(20)
    expect(result.stripeFeeUsd).toBeCloseTo(20 * 0.029 + 0.3, 4)
  })

  it("rejects a configuration that would grant credits >= price", () => {
    expect(() =>
      computeConfigurablePricing({
        priceUsd: 10,
        stripePercent: 0,
        stripeFixedUsd: 0,
        platformOverheadUsd: 0,
        reserveBufferPercent: 0,
        targetProfitPercent: 0,
      }),
    ).toThrow(CreditGrantInvariantError)
  })

  it("scales starter/standard/growth/scale packages with the same formula", () => {
    for (const price of [10, 20, 30, 50]) {
      const result = computeConfigurablePricing({ priceUsd: price })
      expect(result.computedAiCreditsUsd).toBeLessThan(price)
    }
  })
})
