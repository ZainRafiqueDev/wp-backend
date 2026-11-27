import { describe, expect, it } from "vitest"

import { checkAnsweringGate } from "../../src/services/accessGate.service.js"
import { getEntitlementForChatbot } from "../../src/services/billing.service.js"
import { getCostCapBlock, isModelQuotaAvailable, isOverCostCap, recordUsage } from "../../src/services/usage.service.js"
import { createReadyChatbotWithDomain } from "../helpers.js"

// Free plan defaults (src/env.ts): daily $0.05 < weekly $0.15 < monthly
// $0.50 — deliberately tightest-to-loosest, so a single recorded amount
// between the daily and weekly caps exceeds ONLY the daily window while
// leaving week and month comfortably under.
describe("daily/weekly usage is tracked but never blocks a customer (master prompt rule 5)", () => {
  it("usage that exceeds ONLY the daily cap does NOT block — day/week are internal-only, monthly is the only customer-facing limit", async () => {
    const { chatbotId } = await createReadyChatbotWithDomain("usage-windows-daily", `usage-windows-daily-${Date.now()}.test`)
    const entitlement = await getEntitlementForChatbot(chatbotId)
    expect(entitlement.plan).toBe("free")
    expect(entitlement.perModelDailyCapUsd).toBeLessThan(entitlement.perModelWeeklyCapUsd)
    expect(entitlement.perModelWeeklyCapUsd).toBeLessThan(entitlement.perModelCapUsd)

    // $0.08: above the $0.05 daily cap, below the $0.15 weekly and $0.50
    // monthly caps — recordUsage writes this same amount into all three
    // windows at once (see usage.service.ts), so this one call produces
    // exactly the "daily over, week/month fine" shape this test needs.
    // ~$0.08 each (output rates: gemini $0.30/M, openai $0.60/M, anthropic $15/M).
    const overDailyUsages = [
      { provider: "gemini" as const, model: "gemini-flash-latest", inputTokens: 0, outputTokens: 267_000 },
      { provider: "openai" as const, model: "gpt-4o-mini", inputTokens: 0, outputTokens: 134_000 },
      { provider: "anthropic" as const, model: "claude-sonnet-5", inputTokens: 0, outputTokens: 5_400 },
    ]
    for (const usage of overDailyUsages) {
      await recordUsage(chatbotId, [usage])
    }

    // The spend is genuinely recorded (internal tracking survives even
    // though it no longer blocks anything) — every model still has ample
    // monthly room, so quota/cost-cap/gate all agree nothing is blocked.
    for (const model of entitlement.allowedModels) {
      expect(await isModelQuotaAvailable(chatbotId, entitlement, model)).toBe(true)
    }
    expect(await isOverCostCap(chatbotId)).toBe(false)
    expect(await getCostCapBlock(chatbotId)).toBeNull()

    const gate = await checkAnsweringGate(chatbotId)
    expect(gate).toMatchObject({ blocked: false })
  })

  it("usage comfortably under all three caps is NOT blocked", async () => {
    const { chatbotId } = await createReadyChatbotWithDomain("usage-windows-ok", `usage-windows-ok-${Date.now()}.test`)
    const entitlement = await getEntitlementForChatbot(chatbotId)

    // A trivial amount — well under even the tightest (daily) cap.
    await recordUsage(chatbotId, [{ provider: "gemini", model: "gemini-flash-latest", inputTokens: 0, outputTokens: 1_000 }])

    const available = await isModelQuotaAvailable(chatbotId, entitlement, "gemini")
    expect(available).toBe(true)
    expect(await isOverCostCap(chatbotId)).toBe(false)
    expect(await getCostCapBlock(chatbotId)).toBeNull()
  })

  it("monthly exhaustion returns monthly_credits_exhausted and upgrade/top-up copy", async () => {
    const { chatbotId } = await createReadyChatbotWithDomain("usage-windows-month", `usage-windows-month-${Date.now()}.test`)
    const entitlement = await getEntitlementForChatbot(chatbotId)

    const overMonthlyUsages = [
      { provider: "gemini" as const, model: "gemini-flash-latest", inputTokens: 0, outputTokens: 1_900_000 },
      { provider: "openai" as const, model: "gpt-4o-mini", inputTokens: 0, outputTokens: 950_000 },
      { provider: "anthropic" as const, model: "claude-sonnet-5", inputTokens: 0, outputTokens: 40_000 },
    ]
    for (const usage of overMonthlyUsages) {
      await recordUsage(chatbotId, [usage])
    }

    for (const model of entitlement.allowedModels) {
      expect(await isModelQuotaAvailable(chatbotId, entitlement, model)).toBe(false)
    }
    expect(await isOverCostCap(chatbotId)).toBe(true)
    expect(await getCostCapBlock(chatbotId)).toMatchObject({ kind: "monthly" })

    const gate = await checkAnsweringGate(chatbotId)
    expect(gate).toMatchObject({ blocked: true, reason: "monthly_credits_exhausted" })
    expect(gate.visitorMessage).toMatch(/top up|upgrade/i)
    expect(gate.visitorMessage).toMatch(/monthly AI credits/i)
  })
})
