import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join } from "node:path"

import { env } from "../env.js"
import { verifyGroundedClaims } from "./groundingCheck.js"
import {
  citationCoverage,
  mean,
  ndcgAtK,
  percentile,
  precisionAtK,
  recallAtK,
  reciprocalRank,
  type RankedSource,
} from "./ragEvalMetrics.js"

export type RagEvalKind = "lexical" | "synonym" | "negative" | "isolation"

export type RagCorpusChunk = {
  sourceId: string
  topic: string
  text: string
  tenant?: "a" | "b"
}

export type RagEvalQuestion = {
  id: string
  question: string
  relevantSourceIds: string[]
  goldAnswer: string
  hallucinatedAnswer: string
  queryTopic: string
  kind: RagEvalKind
}

export type RagEvalPairResult = {
  id: string
  kind: RagEvalKind
  question: string
  relevantCount: number
  retrievedSourceIds: string[]
  elapsedMs: number
  recallAt5: number
  recallAt10: number
  precisionAt5: number
  mrr: number
  ndcgAt10: number
  cited: number
  grounded: boolean
  hallucinationAccepted: boolean
  foreignHits: number
}

export type RagRetrievalMetrics = {
  recallAt5: number
  recallAt10: number
  precisionAt5: number
  mrr: number
  ndcgAt10: number
  citationCoverage: number
}

export type RagQualityMetrics = {
  groundedAnswerRate: number
  hallucinationRate: number
  isolationViolations: number
}

/**
 * WP-3.5: the same retrieval metrics, sliced by question kind. An aggregate
 * that stays flat can still hide a synonym-recall collapse offset by lexical
 * gains, which is exactly the failure a retrieval change tends to introduce.
 */
export type RagEvalKindBreakdown = {
  kind: RagEvalKind
  pairCount: number
  /**
   * Pairs with a non-empty gold set. Negative questions have none, so their
   * retrieval metrics are averages over nothing — read as 0 but meaning "n/a".
   */
  rankedPairCount: number
  retrieval: RagRetrievalMetrics
  groundedAnswerRate: number
  hallucinationRate: number
  isolationViolations: number
  p95Ms: number
}

export type RagEvalReport = {
  generatedAt: string
  pairCount: number
  retrieval: RagRetrievalMetrics
  quality: RagQualityMetrics
  latency: {
    p50Ms: number
    p95Ms: number
    meanMs: number
  }
  byKind: RagEvalKindBreakdown[]
  pairs: RagEvalPairResult[]
}

/** The subset of a report worth comparing run-to-run; pairs are not. */
export type RagEvalBaseline = {
  generatedAt: string
  pairCount: number
  retrieval: RagRetrievalMetrics
  quality: RagQualityMetrics
  latency: { p50Ms: number; p95Ms: number; meanMs: number }
}

export type RagEvalThresholds = {
  minRecallAt5: number
  minRecallAt10: number
  minPrecisionAt5: number
  minMrr: number
  minNdcgAt10: number
  minCitationCoverage: number
  minGroundedAnswerRate: number
  maxHallucinationRate: number
  maxIsolationViolations: number
  maxP95Ms: number
}

const DEFAULT_EVAL_DIR = join(process.cwd(), "evals", "rag")

export const RAG_EVAL_TOPIC_INDEX: Record<string, number> = {
  sku: 0,
  warranty: 1,
  pricing: 2,
  shipping: 3,
  returns: 4,
  contact: 5,
  hours: 6,
  filter: 7,
  oil: 8,
  battery: 9,
  privacy: 10,
  install: 11,
  payment: 12,
  winter: 13,
  none: 20,
}

export function topicVector(topic: string): number[] {
  const slot = RAG_EVAL_TOPIC_INDEX[topic] ?? RAG_EVAL_TOPIC_INDEX.none
  return Array.from({ length: 1536 }, (_, i) => (i === slot ? 1 : 0))
}

export async function loadRagCorpus(evalDir = DEFAULT_EVAL_DIR): Promise<{ topics: string[]; chunks: RagCorpusChunk[] }> {
  const raw = JSON.parse(await readFile(join(evalDir, "corpus.json"), "utf8")) as {
    topics: string[]
    chunks: RagCorpusChunk[]
  }
  if (!Array.isArray(raw.chunks) || raw.chunks.length === 0) {
    throw new Error("evals/rag/corpus.json must contain labeled chunks")
  }
  return raw
}

export async function loadRagQuestions(evalDir = DEFAULT_EVAL_DIR): Promise<RagEvalQuestion[]> {
  const raw = JSON.parse(await readFile(join(evalDir, "questions.json"), "utf8")) as { pairs: RagEvalQuestion[] }
  if (!Array.isArray(raw.pairs) || raw.pairs.length < 50) {
    throw new Error("evals/rag/questions.json must contain at least 50 labeled pairs")
  }
  return raw.pairs
}

export function resolveRagEvalThresholds(): RagEvalThresholds {
  return {
    minRecallAt5: env.ragEvalMinRecallAt5,
    minRecallAt10: env.ragEvalMinRecallAt10,
    minPrecisionAt5: env.ragEvalMinPrecisionAt5,
    minMrr: env.ragEvalMinMrr,
    minNdcgAt10: env.ragEvalMinNdcgAt10,
    minCitationCoverage: env.ragEvalMinCitationCoverage,
    minGroundedAnswerRate: env.ragEvalMinGroundedAnswerRate,
    maxHallucinationRate: env.ragEvalMaxHallucinationRate,
    maxIsolationViolations: env.ragEvalMaxIsolationViolations,
    maxP95Ms: env.ragEvalMaxP95Ms,
  }
}

export function scoreRetrievedPair(
  question: RagEvalQuestion,
  retrieved: RankedSource[],
  retrievedText: string,
  elapsedMs: number,
  foreignSourceIds: string[],
): RagEvalPairResult {
  const foreign = new Set(foreignSourceIds)
  return {
    id: question.id,
    kind: question.kind,
    question: question.question,
    relevantCount: question.relevantSourceIds.length,
    retrievedSourceIds: retrieved.map((row) => row.sourceId),
    elapsedMs,
    recallAt5: recallAtK(question.relevantSourceIds, retrieved, 5),
    recallAt10: recallAtK(question.relevantSourceIds, retrieved, 10),
    precisionAt5: precisionAtK(question.relevantSourceIds, retrieved, 5),
    mrr: reciprocalRank(question.relevantSourceIds, retrieved),
    ndcgAt10: ndcgAtK(question.relevantSourceIds, retrieved, 10),
    cited: citationCoverage(question.relevantSourceIds, retrieved),
    grounded: verifyGroundedClaims(question.goldAnswer, retrievedText).ok,
    hallucinationAccepted: verifyGroundedClaims(question.hallucinatedAnswer, retrievedText).ok,
    foreignHits: retrieved.filter((row) => foreign.has(row.sourceId)).length,
  }
}

// Retrieval averages skip questions with an empty relevant set (negatives and
// isolation probes) — averaging a "found nothing, correctly" 1.0 into recall
// would inflate it. Those pairs still count toward grounding, isolation, latency.
function retrievalMetricsFor(pairs: RagEvalPairResult[]): RagRetrievalMetrics {
  const ranked = pairs.filter((pair) => pair.relevantCount > 0)
  return {
    recallAt5: mean(ranked.map((pair) => pair.recallAt5)),
    recallAt10: mean(ranked.map((pair) => pair.recallAt10)),
    precisionAt5: mean(ranked.map((pair) => pair.precisionAt5)),
    mrr: mean(ranked.map((pair) => pair.mrr)),
    ndcgAt10: mean(ranked.map((pair) => pair.ndcgAt10)),
    citationCoverage: mean(ranked.map((pair) => pair.cited)),
  }
}

export function breakdownByKind(pairs: RagEvalPairResult[]): RagEvalKindBreakdown[] {
  const kinds = [...new Set(pairs.map((pair) => pair.kind))].sort()
  return kinds.map((kind) => {
    const subset = pairs.filter((pair) => pair.kind === kind)
    return {
      kind,
      pairCount: subset.length,
      rankedPairCount: subset.filter((pair) => pair.relevantCount > 0).length,
      retrieval: retrievalMetricsFor(subset),
      groundedAnswerRate: mean(subset.map((pair) => (pair.grounded ? 1 : 0))),
      hallucinationRate: mean(subset.map((pair) => (pair.hallucinationAccepted ? 1 : 0))),
      isolationViolations: subset.reduce((sum, pair) => sum + pair.foreignHits, 0),
      p95Ms: percentile(subset.map((pair) => pair.elapsedMs), 95),
    }
  })
}

export function aggregateRagEval(pairs: RagEvalPairResult[]): Omit<RagEvalReport, "generatedAt"> {
  return {
    pairCount: pairs.length,
    retrieval: retrievalMetricsFor(pairs),
    quality: {
      groundedAnswerRate: mean(pairs.map((pair) => (pair.grounded ? 1 : 0))),
      hallucinationRate: mean(pairs.map((pair) => (pair.hallucinationAccepted ? 1 : 0))),
      isolationViolations: pairs.reduce((sum, pair) => sum + pair.foreignHits, 0),
    },
    latency: {
      p50Ms: percentile(
        pairs.map((pair) => pair.elapsedMs),
        50,
      ),
      p95Ms: percentile(
        pairs.map((pair) => pair.elapsedMs),
        95,
      ),
      meanMs: mean(pairs.map((pair) => pair.elapsedMs)),
    },
    byKind: breakdownByKind(pairs),
    pairs,
  }
}

/** Absolute floors/ceilings. See evaluateRagRegression for the run-to-run gate. */
export function evaluateRagThresholds(
  report: Pick<RagEvalReport, "retrieval" | "quality" | "latency">,
  thresholds = resolveRagEvalThresholds(),
): string[] {
  const failures: string[] = []
  if (report.retrieval.recallAt5 < thresholds.minRecallAt5) {
    failures.push(`Recall@5 ${report.retrieval.recallAt5.toFixed(3)} < ${thresholds.minRecallAt5}`)
  }
  if (report.retrieval.recallAt10 < thresholds.minRecallAt10) {
    failures.push(`Recall@10 ${report.retrieval.recallAt10.toFixed(3)} < ${thresholds.minRecallAt10}`)
  }
  if (report.retrieval.precisionAt5 < thresholds.minPrecisionAt5) {
    failures.push(`Precision@5 ${report.retrieval.precisionAt5.toFixed(3)} < ${thresholds.minPrecisionAt5}`)
  }
  if (report.retrieval.mrr < thresholds.minMrr) {
    failures.push(`MRR ${report.retrieval.mrr.toFixed(3)} < ${thresholds.minMrr}`)
  }
  if (report.retrieval.ndcgAt10 < thresholds.minNdcgAt10) {
    failures.push(`nDCG@10 ${report.retrieval.ndcgAt10.toFixed(3)} < ${thresholds.minNdcgAt10}`)
  }
  if (report.retrieval.citationCoverage < thresholds.minCitationCoverage) {
    failures.push(`citation coverage ${report.retrieval.citationCoverage.toFixed(3)} < ${thresholds.minCitationCoverage}`)
  }
  if (report.quality.groundedAnswerRate < thresholds.minGroundedAnswerRate) {
    failures.push(`grounded-answer rate ${report.quality.groundedAnswerRate.toFixed(3)} < ${thresholds.minGroundedAnswerRate}`)
  }
  if (report.quality.hallucinationRate > thresholds.maxHallucinationRate) {
    failures.push(`hallucination rate ${report.quality.hallucinationRate.toFixed(3)} > ${thresholds.maxHallucinationRate}`)
  }
  if (report.quality.isolationViolations > thresholds.maxIsolationViolations) {
    failures.push(`isolation violations ${report.quality.isolationViolations} > ${thresholds.maxIsolationViolations}`)
  }
  if (report.latency.p95Ms > thresholds.maxP95Ms) {
    failures.push(`p95 latency ${report.latency.p95Ms.toFixed(1)}ms > ${thresholds.maxP95Ms}ms`)
  }
  return failures
}

export async function writeRagEvalArtifact(report: RagEvalReport, artifactPath = env.ragEvalArtifactPath): Promise<string> {
  const resolved = isAbsolute(artifactPath) ? artifactPath : join(process.cwd(), artifactPath)
  await mkdir(dirname(resolved), { recursive: true })
  await writeFile(resolved, `${JSON.stringify(report, null, 2)}\n`, "utf8")
  await persistRagEvaluation(report, resolved).catch(() => undefined)
  return resolved
}

async function persistRagEvaluation(report: RagEvalReport, artifactPath: string): Promise<void> {
  const { pool } = await import("./db.js")
  if (!pool) return
  const { runWithSystemContext } = await import("./tenantContext.js")
  await runWithSystemContext(async () => {
    await pool.query(
      `insert into rag_evaluations (
         pair_count, recall_at_5, recall_at_10, precision_at_5, mrr, ndcg_at_10,
         citation_coverage, grounded_answer_rate, hallucination_rate, isolation_violations,
         p50_ms, p95_ms, artifact_path
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        report.pairCount,
        report.retrieval.recallAt5,
        report.retrieval.recallAt10,
        report.retrieval.precisionAt5,
        report.retrieval.mrr,
        report.retrieval.ndcgAt10,
        report.retrieval.citationCoverage,
        report.quality.groundedAnswerRate,
        report.quality.hallucinationRate,
        report.quality.isolationViolations,
        report.latency.p50Ms,
        report.latency.p95Ms,
        artifactPath,
      ],
    )
  })
}

// ---------------------------------------------------------------------------
// WP-3.5 regression gate
//
// Absolute thresholds answer "is retrieval good enough". They cannot answer
// "did this change make it worse", because a run may fall from 0.98 to 0.81
// and still clear a 0.80 floor. The baseline closes that gap: every metric is
// compared against the last accepted run, and a drop larger than the allowed
// slack fails even when the absolute gate is still green.
// ---------------------------------------------------------------------------

export function toRagEvalBaseline(report: RagEvalReport): RagEvalBaseline {
  return {
    generatedAt: report.generatedAt,
    pairCount: report.pairCount,
    retrieval: report.retrieval,
    quality: report.quality,
    latency: report.latency,
  }
}

export async function loadRagEvalBaseline(baselinePath = env.ragEvalBaselinePath): Promise<RagEvalBaseline | null> {
  const resolved = isAbsolute(baselinePath) ? baselinePath : join(process.cwd(), baselinePath)
  try {
    return JSON.parse(await readFile(resolved, "utf8")) as RagEvalBaseline
  } catch (err) {
    // A missing baseline is the normal first-run state, not a failure. Any
    // other read/parse error is worth surfacing rather than silently skipping.
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return null
    throw err
  }
}

export async function writeRagEvalBaseline(
  baseline: RagEvalBaseline,
  baselinePath = env.ragEvalBaselinePath,
): Promise<string> {
  const resolved = isAbsolute(baselinePath) ? baselinePath : join(process.cwd(), baselinePath)
  await mkdir(dirname(resolved), { recursive: true })
  await writeFile(resolved, `${JSON.stringify(baseline, null, 2)}\n`, "utf8")
  return resolved
}

/**
 * Compares a run against a baseline. Higher-is-better metrics fail on a drop
 * beyond `maxRegression`; hallucination and isolation are lower-is-better and
 * fail on a rise. Latency is reported but not gated here — `maxP95Ms` already
 * owns that, and p95 on a 50-question fixture set is too noisy to diff.
 *
 * Returns an empty list when there is no baseline yet.
 */
export function evaluateRagRegression(
  report: Pick<RagEvalReport, "retrieval" | "quality">,
  baseline: RagEvalBaseline | null,
  maxRegression = env.ragEvalMaxRegression,
): string[] {
  if (!baseline) return []

  const failures: string[] = []

  const higherIsBetter: [string, number, number][] = [
    ["Recall@5", report.retrieval.recallAt5, baseline.retrieval.recallAt5],
    ["Recall@10", report.retrieval.recallAt10, baseline.retrieval.recallAt10],
    ["Precision@5", report.retrieval.precisionAt5, baseline.retrieval.precisionAt5],
    ["MRR", report.retrieval.mrr, baseline.retrieval.mrr],
    ["nDCG@10", report.retrieval.ndcgAt10, baseline.retrieval.ndcgAt10],
    ["citation coverage", report.retrieval.citationCoverage, baseline.retrieval.citationCoverage],
    ["grounded-answer rate", report.quality.groundedAnswerRate, baseline.quality.groundedAnswerRate],
  ]

  for (const [label, current, previous] of higherIsBetter) {
    const drop = previous - current
    if (drop > maxRegression) {
      failures.push(`${label} regressed ${drop.toFixed(3)} (${previous.toFixed(3)} → ${current.toFixed(3)}), allowed ${maxRegression}`)
    }
  }

  const hallucinationRise = report.quality.hallucinationRate - baseline.quality.hallucinationRate
  if (hallucinationRise > maxRegression) {
    failures.push(
      `hallucination rate rose ${hallucinationRise.toFixed(3)} (${baseline.quality.hallucinationRate.toFixed(3)} → ${report.quality.hallucinationRate.toFixed(3)}), allowed ${maxRegression}`,
    )
  }

  // Isolation is a hard invariant: any increase at all is a tenant-leak
  // regression, so it gets no slack.
  if (report.quality.isolationViolations > baseline.quality.isolationViolations) {
    failures.push(
      `isolation violations rose ${baseline.quality.isolationViolations} → ${report.quality.isolationViolations}`,
    )
  }

  return failures
}
