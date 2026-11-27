import { describe, expect, it } from "vitest"

import { fuseLexicalAndVector, reciprocalRankScore, resolveRetrievalMode } from "../../src/lib/hybridRetrieval.js"

describe("WP-2.3 hybrid retrieval fusion", () => {
  it("uses reciprocal rank fusion and keeps both lexical and vector evidence", () => {
    const fused = fuseLexicalAndVector(
      [
        { id: "sku", content: "SKU-99XZ filter", fileName: "parts.txt", source: "lexical", rank: 1 },
        { id: "shared", content: "shared", fileName: "shared.txt", source: "lexical", rank: 2 },
      ],
      [
        { id: "synonym", content: "automobile warranty", fileName: "warranty.txt", source: "vector", rank: 1 },
        { id: "shared", content: "shared", fileName: "shared.txt", source: "vector", rank: 2 },
      ],
      60,
    )

    expect(fused[0].id).toBe("shared")
    expect(fused[0].score).toBeCloseTo(reciprocalRankScore(2, 60) * 2)
    expect(fused.some((chunk) => chunk.id === "sku" && chunk.lexicalRank === 1 && chunk.vectorRank === null)).toBe(true)
    expect(fused.some((chunk) => chunk.id === "synonym" && chunk.vectorRank === 1 && chunk.lexicalRank === null)).toBe(
      true,
    )
  })

  it("defaults to hybrid so rollback is RETRIEVAL_MODE=vector", () => {
    expect(resolveRetrievalMode()).toBe("hybrid")
  })
})
