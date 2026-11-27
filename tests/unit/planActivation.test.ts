import { describe, expect, it } from "vitest"

import { env } from "../../src/env.js"
import { CRAWL_PLUS_20, safeCreditsFromCash, usdGreaterThan } from "../../src/lib/planEconomics.js"
import { activatePlanSchema } from "../../src/validators/admin.validator.js"

describe("WP-2.6 Full Custom safe-credit ledger", () => {
  it("computes safe credits from cash using the Crawl Plus AI budget ratio", () => {
    const safe = safeCreditsFromCash(100, CRAWL_PLUS_20.aiBudgetRatio)
    expect(safe).toBe(40)
    expect(safe).toBeLessThan(100)
    expect(env.adminPlanAiBudgetRatio).toBe(CRAWL_PLUS_20.aiBudgetRatio)
  })

  it("treats credits above the safe amount as an override case", () => {
    expect(usdGreaterThan(50, 40)).toBe(true)
    expect(usdGreaterThan(40, 40)).toBe(false)
    expect(usdGreaterThan(39.99, 40)).toBe(false)
  })

  it("requires plan, monthly credits, models, and attested cash", () => {
    const parsed = activatePlanSchema.parse({
      plan: "full_custom",
      monthlyCreditUsd: 40,
      allowedModels: ["openai"],
      cashCollectedUsd: 100,
    })
    expect(parsed.plan).toBe("full_custom")
    expect(() =>
      activatePlanSchema.parse({
        plan: "full_custom",
        monthlyCreditUsd: 40,
        allowedModels: ["openai"],
      }),
    ).toThrow()
  })
})
