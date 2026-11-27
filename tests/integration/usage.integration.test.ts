import { describe, expect, it } from "vitest"

import { pool } from "../../src/lib/db.js"
import { getCurrentPeriodCostUsd, isOverCostCap, recordUsage } from "../../src/services/usage.service.js"
import { createReadyChatbotWithDomain } from "../helpers.js"

// A free-plan chatbot has no `subscriptions` row at all (see
// billing.service.ts's getEntitlementForChatbot — no row is treated as
// plan "free", not an error), so every chatbot createReadyChatbotWithDomain
// makes is a free-plan chatbot by construction, with no extra setup needed.
describe("Token-based metering (Task 3)", () => {
  it("accumulates cost across multiple recordUsage calls within the same billing period", async () => {
    const { chatbotId } = await createReadyChatbotWithDomain("usage-accum", `usage-accum-${Date.now()}.test`)

    await recordUsage(chatbotId, [{ provider: "openai", model: "gpt-4o-mini", inputTokens: 1_000_000, outputTokens: 0 }])
    const afterFirst = await getCurrentPeriodCostUsd(chatbotId)
    expect(afterFirst).toBeCloseTo(0.15, 6)

    await recordUsage(chatbotId, [{ provider: "openai", model: "gpt-4o-mini", inputTokens: 1_000_000, outputTokens: 0 }])
    const afterSecond = await getCurrentPeriodCostUsd(chatbotId)
    expect(afterSecond).toBeCloseTo(0.3, 6)
  })

  it("is not over cap for a free-plan chatbot with no usage yet", async () => {
    const { chatbotId } = await createReadyChatbotWithDomain("usage-fresh", `usage-fresh-${Date.now()}.test`)
    expect(await isOverCostCap(chatbotId)).toBe(false)
  })

  it("goes over cap once a free-plan chatbot's recorded cost reaches env.freePlanMonthlyCostCapUsd", async () => {
    const { chatbotId } = await createReadyChatbotWithDomain("usage-cap", `usage-cap-${Date.now()}.test`)

    // Free plan allows anthropic/openai/gemini, each with its own monthly cap.
    // isOverCostCap is true only when every allowed model is exhausted.
    // Default cap is $0.50/month (FREE_PLAN_MONTHLY_COST_CAP_USD).
    for (const provider of ["anthropic", "openai", "gemini"] as const) {
      const model =
        provider === "anthropic" ? "claude-sonnet-5" : provider === "openai" ? "gpt-4o-mini" : "gemini-flash-latest"
      await recordUsage(chatbotId, [{ provider, model, inputTokens: 0, outputTokens: 5_000_000 }])
    }

    expect(await isOverCostCap(chatbotId)).toBe(true)
  })

  it("a paid, active subscription is never checked against the free-tier cap, regardless of usage", async () => {
    const { chatbotId, userId } = await createReadyChatbotWithDomain("usage-paid", `usage-paid-${Date.now()}.test`)

    await pool!.query(
      `insert into subscriptions (user_id, stripe_customer_id, plan, status)
       values ($1, $2, 'crawl_plus', 'active')`,
      [userId, `cus_test_${Date.now()}`],
    )

    await recordUsage(chatbotId, [{ provider: "openai", model: "gpt-4o-mini", inputTokens: 0, outputTokens: 10_000_000 }])

    expect(await isOverCostCap(chatbotId)).toBe(false)
  })

  it("a canceled subscription reverts to free-tier cap checking", async () => {
    const { chatbotId, userId } = await createReadyChatbotWithDomain("usage-canceled", `usage-canceled-${Date.now()}.test`)

    await pool!.query(
      `insert into subscriptions (user_id, stripe_customer_id, plan, status)
       values ($1, $2, 'crawl_plus', 'canceled')`,
      [userId, `cus_test_${Date.now()}`],
    )

    // Reverted to "free" (isEntitledStatus('canceled') is false), so every
    // free-plan allowed model must be exhausted for isOverCostCap to be true.
    for (const provider of ["anthropic", "openai", "gemini"] as const) {
      const model =
        provider === "anthropic" ? "claude-sonnet-5" : provider === "openai" ? "gpt-4o-mini" : "gemini-flash-latest"
      await recordUsage(chatbotId, [{ provider, model, inputTokens: 0, outputTokens: 5_000_000 }])
    }

    expect(await isOverCostCap(chatbotId)).toBe(true)
  })
})
