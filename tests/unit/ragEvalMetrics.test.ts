import { describe, expect, it } from "vitest"

import { evaluateRagThresholds, scoreRetrievedPair } from "../../src/lib/ragEval.js"
import { ndcgAtK, precisionAtK, recallAtK, reciprocalRank } from "../../src/lib/ragEvalMetrics.js"

describe("WP-2.5 RAG eval metrics", () => {
  it("computes recall, precision, MRR, and nDCG on a known ranking", () => {
    const relevant = ["a", "b"]
    const retrieved = [{ sourceId: "x" }, { sourceId: "a" }, { sourceId: "b" }]
    expect(recallAtK(relevant, retrieved, 5)).toBe(1)
    expect(recallAtK(relevant, retrieved, 1)).toBe(0)
    expect(precisionAtK(relevant, retrieved, 2)).toBe(0.5)
    expect(reciprocalRank(relevant, retrieved)).toBeCloseTo(0.5)
    expect(ndcgAtK(relevant, retrieved, 3)).toBeGreaterThan(0.5)
    expect(ndcgAtK(relevant, retrieved, 3)).toBeLessThan(1)
  })

  it("treats a fabricated price in retrieved context as an accepted hallucination", () => {
    const scored = scoreRetrievedPair(
      {
        id: "q",
        question: "price?",
        relevantSourceIds: ["pricing-crawl-plus"],
        goldAnswer: "Crawl Plus is $20.00 per month.",
        hallucinatedAnswer: "Crawl Plus is $9,999.00 per month.",
        queryTopic: "pricing",
        kind: "lexical",
      },
      [{ sourceId: "pricing-crawl-plus" }],
      "Crawl Plus is $20.00 per month and the included AI budget is $8.00.",
      12,
      ["secret-tenant-b"],
    )
    expect(scored.grounded).toBe(true)
    expect(scored.hallucinationAccepted).toBe(false)
    expect(scored.foreignHits).toBe(0)
  })

  it("fails the gate when recall is below the configured threshold", () => {
    const failures = evaluateRagThresholds(
      {
        retrieval: {
          recallAt5: 0.1,
          recallAt10: 0.1,
          precisionAt5: 0.1,
          mrr: 0.1,
          ndcgAt10: 0.1,
          citationCoverage: 0.1,
        },
        quality: { groundedAnswerRate: 0.1, hallucinationRate: 0.9, isolationViolations: 3 },
        latency: { p50Ms: 10, p95Ms: 20, meanMs: 12 },
      },
      {
        minRecallAt5: 0.8,
        minRecallAt10: 0.85,
        minPrecisionAt5: 0.35,
        minMrr: 0.7,
        minNdcgAt10: 0.75,
        minCitationCoverage: 0.85,
        minGroundedAnswerRate: 0.75,
        maxHallucinationRate: 0.05,
        maxIsolationViolations: 0,
        maxP95Ms: 2000,
      },
    )
    expect(failures.some((line) => line.includes("Recall@5"))).toBe(true)
    expect(failures.some((line) => line.includes("hallucination rate"))).toBe(true)
    expect(failures.some((line) => line.includes("isolation violations"))).toBe(true)
  })
})
