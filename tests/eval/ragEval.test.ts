import { describe, expect, it, vi } from "vitest"

import { env } from "../../src/env.js"
import {
  aggregateRagEval,
  evaluateRagRegression,
  evaluateRagThresholds,
  loadRagCorpus,
  loadRagEvalBaseline,
  loadRagQuestions,
  scoreRetrievedPair,
  toRagEvalBaseline,
  topicVector,
  writeRagEvalArtifact,
  writeRagEvalBaseline,
} from "../../src/lib/ragEval.js"

const queryTopicByText = new Map<string, string>()

vi.mock("../../src/services/embeddings.service.js", () => ({
  embedTexts: vi.fn(async (texts: string[]) => [topicVector(queryTopicByText.get(texts[0] ?? "") || "none")]),
  toPgVectorLiteral: (embedding: number[]) => `[${embedding.join(",")}]`,
  activeEmbeddingIdentity: () => ({ model: "text-embedding-3-small", dim: 1536 }),
}))

// This eval measures retrieval quality (recall/MRR/isolation) over the
// fused hybrid order across 50+ questions — mock the WP-3.2 rerank LLM call
// out (real provider keys are configured in this environment's .env) so it
// doesn't burn real API quota / rate-limit-driven latency across every
// question. The rerank stage itself has its own dedicated unit tests.
vi.mock("../../src/lib/ai.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/ai.js")>()
  return { ...actual, completeCheaply: vi.fn(async () => null) }
})

const { pool } = await import("../../src/lib/db.js")
const { lookupRelevantDocumentChunks } = await import("../../src/services/documentIngestion.service.js")
const { seedOwnedChatbot } = await import("../helpers/seedTenant.js")

function vectorLiteral(values: number[]): string {
  return `[${values.join(",")}]`
}

describe("WP-2.5 RAG evaluation gate", () => {
  it("meets recall, MRR, groundedness, isolation, and latency thresholds on the labeled set", async () => {
    if (env.ragEvalSkip) {
      expect(env.ragEvalSkip, "RAG_EVAL_SKIP is an explicit emergency override, not a default").toBe(true)
      return
    }

    const corpus = await loadRagCorpus()
    const questions = await loadRagQuestions()
    expect(questions.length).toBeGreaterThanOrEqual(50)

    const tenantA = await seedOwnedChatbot("rag-eval-a")
    const tenantB = await seedOwnedChatbot("rag-eval-b")
    const foreignSourceIds = corpus.chunks.filter((chunk) => chunk.tenant === "b").map((chunk) => chunk.sourceId)

    for (const chunk of corpus.chunks) {
      const chatbotId = chunk.tenant === "b" ? tenantB.chatbotId : tenantA.chatbotId
      const doc = await pool!.query<{ id: string }>(
        `insert into chatbot_documents (chatbot_id, file_name, file_type, file_size, status, chunk_count)
         values ($1, $2, 'txt', $3, 'ready', 1) returning id`,
        [chatbotId, chunk.sourceId, chunk.text.length],
      )
      await pool!.query(
        `insert into chatbot_document_chunks
           (document_id, chatbot_id, content, embedding, content_tsv, source_type, embedding_model, embedding_dim)
         values ($1, $2, $3, $4::vector, to_tsvector('simple', $3), 'document', 'text-embedding-3-small', 1536)`,
        [doc.rows[0].id, chatbotId, chunk.text, vectorLiteral(topicVector(chunk.topic))],
      )
    }

    for (const question of questions) {
      queryTopicByText.set(question.question, question.queryTopic)
    }

    const pairs = []
    for (const question of questions) {
      const startedAt = Date.now()
      const pages = await lookupRelevantDocumentChunks(tenantA.chatbotId, question.question, 10)
      const elapsedMs = Date.now() - startedAt
      const retrieved = pages.map((page) => ({ sourceId: page.title }))
      pairs.push(
        scoreRetrievedPair(question, retrieved, pages.map((page) => page.text).join("\n"), elapsedMs, foreignSourceIds),
      )
    }

    const report = {
      generatedAt: new Date().toISOString(),
      ...aggregateRagEval(pairs),
    }
    const artifactPath = await writeRagEvalArtifact(report)
    const baseline = await loadRagEvalBaseline()
    const regressions = evaluateRagRegression(report, baseline)
    // Absolute thresholds are hermetic and always gate. The baseline diff is
    // only meaningful under `npm run eval:rag`, where this spec runs alone —
    // in a whole-suite run the HNSW index is searching a much larger, actively
    // written table, which moves the ranking metrics for reasons unrelated to
    // any retrieval change. Report it either way; fail on it only when asked.
    const failures = [
      ...evaluateRagThresholds(report),
      ...(env.ragEvalEnforceBaseline ? regressions : []),
    ]
    if (regressions.length > 0 && !env.ragEvalEnforceBaseline) {
      console.log(`[rag-eval] baseline deltas (not gated in a full-suite run): ${regressions.join("; ")}`)
    }

    console.log(
      `[rag-eval] pairs=${report.pairCount} recall@5=${report.retrieval.recallAt5.toFixed(3)} recall@10=${report.retrieval.recallAt10.toFixed(3)} p@5=${report.retrieval.precisionAt5.toFixed(3)} mrr=${report.retrieval.mrr.toFixed(3)} ndcg@10=${report.retrieval.ndcgAt10.toFixed(3)} cite=${report.retrieval.citationCoverage.toFixed(3)} grounded=${report.quality.groundedAnswerRate.toFixed(3)} halluc=${report.quality.hallucinationRate.toFixed(3)} iso=${report.quality.isolationViolations} p50=${report.latency.p50Ms.toFixed(1)}ms p95=${report.latency.p95Ms.toFixed(1)}ms baseline=${baseline?.generatedAt ?? "none"} artifact=${artifactPath}`,
    )
    for (const kind of report.byKind) {
      const retrieval =
        kind.rankedPairCount > 0
          ? `recall@5=${kind.retrieval.recallAt5.toFixed(3)} recall@10=${kind.retrieval.recallAt10.toFixed(3)} mrr=${kind.retrieval.mrr.toFixed(3)} ndcg@10=${kind.retrieval.ndcgAt10.toFixed(3)}`
          : "retrieval=n/a(no gold set)"
      console.log(
        `[rag-eval:${kind.kind}] pairs=${kind.pairCount} ${retrieval} grounded=${kind.groundedAnswerRate.toFixed(3)} halluc=${kind.hallucinationRate.toFixed(3)} iso=${kind.isolationViolations} p95=${kind.p95Ms.toFixed(1)}ms`,
      )
    }

    // Re-baseline only on an explicit opt-in, and only from a run that passed
    // both gates — otherwise a bad run would enshrine itself as the new floor.
    if (env.ragEvalUpdateBaseline && failures.length === 0) {
      console.log(`[rag-eval] baseline updated at ${await writeRagEvalBaseline(toRagEvalBaseline(report))}`)
    }

    expect(failures, failures.join("; ")).toEqual([])
    expect(report.quality.isolationViolations).toBe(0)
  })
})
