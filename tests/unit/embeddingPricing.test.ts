import { describe, expect, it } from "vitest"

import { billedEmbeddingUsd } from "../../src/lib/embeddingBudget.js"
import {
  EmbeddingPriceMissingError,
  estimateEmbeddingCostUsd,
  estimateEmbeddingTokens,
  requireEmbeddingRatePerMillion,
  resolveEmbeddingIdentity,
} from "../../src/lib/embeddingPricing.js"

describe("WP-2.4 embedding pricing", () => {
  it("fails closed when the embedding model has no price", () => {
    expect(() => requireEmbeddingRatePerMillion("not-a-priced-embedding-model")).toThrow(EmbeddingPriceMissingError)
    expect(() => estimateEmbeddingCostUsd("not-a-priced-embedding-model", 1_000)).toThrow(EmbeddingPriceMissingError)
  })

  it("prices text-embedding-3-small at $0.02 per million tokens", () => {
    expect(estimateEmbeddingCostUsd("text-embedding-3-small", 1_000_000)).toBeCloseTo(0.02, 8)
    expect(estimateEmbeddingTokens("abcd")).toBe(1)
  })

  it("resolves the active 1536-dim identity used for stored vectors", () => {
    const identity = resolveEmbeddingIdentity()
    expect(identity.model).toBe("text-embedding-3-small")
    expect(identity.dim).toBe(1536)
  })

  it("bills at least one microdollar so short queries cannot stall the ledger at zero", () => {
    expect(billedEmbeddingUsd(1.2e-7, 6)).toBe(0.000001)
    expect(billedEmbeddingUsd(0.02, 1_000_000)).toBe(0.02)
  })
})
