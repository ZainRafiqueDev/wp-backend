import { describe, expect, it } from "vitest"

import { estimateCostUsd } from "../../src/lib/aiPricing.js"

describe("estimateCostUsd", () => {
  it("computes cost from a known model's $/1M-token rate", () => {
    // gpt-4o-mini default rate: $0.15/1M input, $0.60/1M output.
    const cost = estimateCostUsd("gpt-4o-mini", 1_000_000, 1_000_000)
    expect(cost).toBeCloseTo(0.15 + 0.6, 6)
  })

  it("scales linearly with token count", () => {
    const cost = estimateCostUsd("gpt-4o-mini", 500_000, 0)
    expect(cost).toBeCloseTo(0.075, 6)
  })

  it("returns 0 for zero tokens", () => {
    expect(estimateCostUsd("gpt-4o-mini", 0, 0)).toBe(0)
  })

  it("treats an unrecognized, non-self-hosted model as $0 rather than a fabricated placeholder", () => {
    expect(estimateCostUsd("some-future-model-not-in-the-table", 1_000_000, 1_000_000)).toBe(0)
  })
})
