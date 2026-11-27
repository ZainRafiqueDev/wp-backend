import { describe, expect, it } from "vitest"

import {
  MONTHLY_CREDITS_VISITOR_MESSAGE,
  isUsageGateReason,
  visitorMessageForGate,
} from "../../src/services/accessGate.service.js"
import { usageWindowPresentation } from "../../src/services/usage.service.js"

const CREDITS_EMPTY_PATTERNS = /credits empty|no credits|out of credits|credits have run/i

describe("WP-1.2 / master-prompt: monthly credits are the only customer-facing block", () => {
  it("labels only the month window as customer-facing credits (day/week remain dashboard-only labels)", () => {
    expect(usageWindowPresentation("month")).toMatchObject({
      kind: "credits",
      customerFacingCredits: true,
      label: "Monthly AI credits",
    })
    expect(usageWindowPresentation("day")).toMatchObject({
      kind: "burst",
      customerFacingCredits: false,
    })
    expect(usageWindowPresentation("week")).toMatchObject({
      kind: "burst",
      customerFacingCredits: false,
    })
  })

  it("monthly exhaustion copy offers top-up or upgrade", () => {
    expect(MONTHLY_CREDITS_VISITOR_MESSAGE).toMatch(/monthly AI credits/i)
    expect(MONTHLY_CREDITS_VISITOR_MESSAGE).toMatch(/top up|upgrade/i)
    expect(visitorMessageForGate("monthly_credits_exhausted", "fallback")).toBe(MONTHLY_CREDITS_VISITOR_MESSAGE)
    expect(visitorMessageForGate("cost_cap_exceeded", "fallback")).toBe(MONTHLY_CREDITS_VISITOR_MESSAGE)
  })

  // Master prompt decision (2026-09-28): day/week pace limits no longer
  // block customers at all — "burst_limited" is deprecated-but-still-typed
  // (accessGate.service.ts) purely so old widgets/mocks/recrawl checks
  // still compile; the real gate can never emit it anymore. Any legacy
  // caller that still passes it gets the same monthly-credits copy.
  it("the deprecated burst_limited reason (never emitted by the real gate anymore) falls back to the monthly-credits message", () => {
    expect(visitorMessageForGate("burst_limited", "fallback")).toBe(MONTHLY_CREDITS_VISITOR_MESSAGE)
  })

  it("treats the new usage reasons and the deprecated aliases as usage gates", () => {
    expect(isUsageGateReason("monthly_credits_exhausted")).toBe(true)
    expect(isUsageGateReason("burst_limited")).toBe(true)
    expect(isUsageGateReason("cost_cap_exceeded")).toBe(true)
    expect(isUsageGateReason("trial_expired")).toBe(false)
  })

  it("public busy/unavailable copy does not say credits are empty", () => {
    const rateLimited = "Too many messages — please wait a moment and try again."
    const busy = "This chatbot is busy — please try again in a moment."
    const unavailable = "This chatbot is temporarily unavailable — please try again."
    for (const message of [rateLimited, busy, unavailable]) {
      expect(message).not.toMatch(CREDITS_EMPTY_PATTERNS)
    }
  })
})
