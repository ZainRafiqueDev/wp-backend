import { describe, expect, it } from "vitest"

import {
  aggregateRagEval,
  breakdownByKind,
  evaluateRagRegression,
  toRagEvalBaseline,
  type RagEvalBaseline,
  type RagEvalKind,
  type RagEvalPairResult,
} from "../../src/lib/ragEval.js"

function pair(overrides: Partial<RagEvalPairResult> & { id: string; kind: RagEvalKind }): RagEvalPairResult {
  return {
    question: `q-${overrides.id}`,
    relevantCount: 1,
    retrievedSourceIds: ["src-1"],
    elapsedMs: 100,
    recallAt5: 1,
    recallAt10: 1,
    precisionAt5: 0.4,
    mrr: 1,
    ndcgAt10: 1,
    cited: 1,
    grounded: true,
    hallucinationAccepted: false,
    foreignHits: 0,
    ...overrides,
  }
}

function baseline(overrides: {
  retrieval?: Partial<RagEvalBaseline["retrieval"]>
  quality?: Partial<RagEvalBaseline["quality"]>
} = {}): RagEvalBaseline {
  return {
    generatedAt: "2026-09-27T00:00:00.000Z",
    pairCount: 50,
    retrieval: {
      recallAt5: 0.9,
      recallAt10: 0.95,
      precisionAt5: 0.4,
      mrr: 0.85,
      ndcgAt10: 0.88,
      citationCoverage: 0.92,
      ...overrides.retrieval,
    },
    quality: {
      groundedAnswerRate: 0.9,
      hallucinationRate: 0.02,
      isolationViolations: 0,
      ...overrides.quality,
    },
    latency: { p50Ms: 80, p95Ms: 150, meanMs: 90 },
  }
}

function reportFrom(base: RagEvalBaseline): Pick<RagEvalBaseline, "retrieval" | "quality"> {
  return { retrieval: { ...base.retrieval }, quality: { ...base.quality } }
}

describe("breakdownByKind", () => {
  it("reports each question kind separately, sorted by kind", () => {
    const kinds = breakdownByKind([
      pair({ id: "s1", kind: "synonym", recallAt5: 0.5, mrr: 0.5 }),
      pair({ id: "l1", kind: "lexical" }),
      pair({ id: "l2", kind: "lexical" }),
    ])

    expect(kinds.map((entry) => entry.kind)).toEqual(["lexical", "synonym"])
    expect(kinds[0].pairCount).toBe(2)
    expect(kinds[0].retrieval.recallAt5).toBe(1)
    expect(kinds[1].retrieval.recallAt5).toBe(0.5)
  })

  it("surfaces a per-kind collapse that the aggregate average hides", () => {
    // Five perfect lexical questions drag the aggregate up far enough that a
    // total synonym failure still looks like healthy overall recall.
    const pairs = [
      ...Array.from({ length: 5 }, (_, i) => pair({ id: `l${i}`, kind: "lexical" })),
      pair({ id: "s1", kind: "synonym", recallAt5: 0, recallAt10: 0, mrr: 0, ndcgAt10: 0 }),
    ]

    const report = aggregateRagEval(pairs)
    expect(report.retrieval.recallAt5).toBeGreaterThan(0.8)

    const synonym = report.byKind.find((entry) => entry.kind === "synonym")
    expect(synonym?.retrieval.recallAt5).toBe(0)
  })

  it("excludes questions with no relevant sources from retrieval averages", () => {
    // Negatives have an empty gold set; scoring them as 0 recall would make a
    // correct 'nothing to find' look like a retrieval miss.
    const kinds = breakdownByKind([
      pair({ id: "n1", kind: "negative", relevantCount: 0, recallAt5: 0, mrr: 0, grounded: true }),
    ])

    expect(kinds[0].pairCount).toBe(1)
    expect(kinds[0].rankedPairCount).toBe(0)
    expect(kinds[0].groundedAnswerRate).toBe(1)
  })
})

describe("evaluateRagRegression", () => {
  it("passes when there is no baseline yet", () => {
    expect(evaluateRagRegression(reportFrom(baseline()), null, 0.03)).toEqual([])
  })

  it("passes when metrics are unchanged", () => {
    const base = baseline()
    expect(evaluateRagRegression(reportFrom(base), base, 0.03)).toEqual([])
  })

  it("tolerates a drop within the allowed slack", () => {
    const base = baseline()
    const report = reportFrom(base)
    report.retrieval.recallAt5 = base.retrieval.recallAt5 - 0.02

    expect(evaluateRagRegression(report, base, 0.03)).toEqual([])
  })

  it("fails a drop beyond the slack even when the absolute value is still high", () => {
    const base = baseline()
    const report = reportFrom(base)
    report.retrieval.recallAt5 = 0.82

    const failures = evaluateRagRegression(report, base, 0.03)
    expect(failures).toHaveLength(1)
    expect(failures[0]).toContain("Recall@5 regressed")
    expect(failures[0]).toContain("0.900 → 0.820")
  })

  it("reports every regressed metric, not just the first", () => {
    const base = baseline()
    const report = reportFrom(base)
    report.retrieval.mrr = 0.5
    report.retrieval.ndcgAt10 = 0.5
    report.quality.groundedAnswerRate = 0.5

    const failures = evaluateRagRegression(report, base, 0.03)
    expect(failures).toHaveLength(3)
  })

  it("treats a rising hallucination rate as a regression", () => {
    const base = baseline()
    const report = reportFrom(base)
    report.quality.hallucinationRate = 0.2

    const failures = evaluateRagRegression(report, base, 0.03)
    expect(failures.join(" ")).toContain("hallucination rate rose")
  })

  it("ignores improvements", () => {
    const base = baseline()
    const report = reportFrom(base)
    report.retrieval.recallAt5 = 1
    report.quality.hallucinationRate = 0

    expect(evaluateRagRegression(report, base, 0.03)).toEqual([])
  })

  it("gives isolation violations no slack at all", () => {
    const base = baseline()
    const report = reportFrom(base)
    report.quality.isolationViolations = 1

    const failures = evaluateRagRegression(report, base, 0.5)
    expect(failures.join(" ")).toContain("isolation violations rose 0 → 1")
  })
})

describe("toRagEvalBaseline", () => {
  it("keeps the aggregate metrics and drops the per-pair detail", () => {
    const report = {
      generatedAt: "2026-09-28T00:00:00.000Z",
      ...aggregateRagEval([pair({ id: "l1", kind: "lexical" })]),
    }

    const stored = toRagEvalBaseline(report)
    expect(stored.pairCount).toBe(1)
    expect(stored.retrieval.recallAt5).toBe(1)
    expect(stored).not.toHaveProperty("pairs")
    expect(stored).not.toHaveProperty("byKind")
  })
})
