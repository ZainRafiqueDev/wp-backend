import { describe, expect, it } from "vitest"

import { recommendedHnswEfSearch } from "../../src/lib/pgvectorHnsw.js"

describe("recommendedHnswEfSearch", () => {
  it("scales with corpus size without replacing PGVECTOR_HNSW_EF_SEARCH", () => {
    expect(recommendedHnswEfSearch(0)).toBe(20)
    expect(recommendedHnswEfSearch(999)).toBe(20)
    expect(recommendedHnswEfSearch(1000)).toBe(40)
    expect(recommendedHnswEfSearch(49999)).toBe(40)
    expect(recommendedHnswEfSearch(50000)).toBe(80)
  })
})
