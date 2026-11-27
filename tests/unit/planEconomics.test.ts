import { describe, expect, it } from "vitest"

import {
  CRAWL_PLUS_20,
  DEFAULT_TOPUP_SALE_USD,
  computeSaleEconomics,
  grantedCreditsFromSale,
} from "../../src/lib/planEconomics.js"

describe("Crawl Plus $20 sale economics", () => {
  it("leaves $8 as the maximum safe AI credit and $10.40 profit", () => {
    expect(CRAWL_PLUS_20).toMatchObject({
      revenueUsd: 20,
      stripeFeeUsd: 1.1,
      platformOverheadUsd: 0.5,
      availableAfterFeesUsd: 18.4,
      targetProfitUsd: 10.4,
      maximumSafeCreditsUsd: 8,
    })
    expect(CRAWL_PLUS_20.aiBudgetRatio).toBeCloseTo(0.4)
    expect(CRAWL_PLUS_20.profitRatio).toBeCloseTo(0.52)
  })

  it("rejects a package that cannot cover fees, overhead, and profit", () => {
    expect(() =>
      computeSaleEconomics({
        revenueUsd: 20,
        stripeFeeUsd: 1.1,
        platformOverheadUsd: 0.5,
        targetProfitUsd: 19,
      }),
    ).toThrow(/loses money/)
  })

  it("grants AI credit below the configured top-up sale at the Crawl Plus ratio", () => {
    const granted = grantedCreditsFromSale(DEFAULT_TOPUP_SALE_USD, CRAWL_PLUS_20.aiBudgetRatio)
    expect(granted).toBeLessThan(DEFAULT_TOPUP_SALE_USD)
    expect(granted).toBe(4)
  })

  it("refuses to compute a grant that is not less than cash collected", () => {
    expect(() => grantedCreditsFromSale(DEFAULT_TOPUP_SALE_USD, 1)).toThrow(/not less than cash collected/)
  })
})
