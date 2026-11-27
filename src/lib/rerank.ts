import { completeCheaply, type AiUsage } from "./ai.js"
import { cheapCallAuthorizer } from "./cheapCallBilling.js"
import { env } from "../env.js"
import { log } from "./logger.js"
import { recordUsage } from "../services/usage.service.js"
import type { FusedChunk } from "./hybridRetrieval.js"

// Keep each candidate's content bounded in the rerank prompt itself — the
// reranker only needs enough text to judge relevance, not the full chunk
// (that full content is what actually reaches the answering LLM afterward).
const MAX_CANDIDATE_CHARS = 600

function rerankPrompt(question: string, candidates: FusedChunk[]): string {
  const listing = candidates
    .map((chunk, index) => `[${index + 1}] (from ${chunk.fileName})\n${chunk.content.slice(0, MAX_CANDIDATE_CHARS)}`)
    .join("\n\n")

  return `You are a search relevance reranker for a customer support AI.

Given a customer's question and a numbered list of candidate document passages, order the passage numbers from MOST to LEAST relevant to answering the question. A passage is relevant only if it actually helps answer the question — ignore passages that are merely topically related but don't contain the needed information.

Customer's question:
${question}

Candidate passages:
${listing}

Output ONLY a comma-separated list of ALL ${candidates.length} passage numbers, ordered most-to-least relevant. No explanation, no preamble. Example format: 3,1,4,2`
}

// Any candidate number the model's response doesn't mention (missing due to
// truncation, a malformed response, etc.) is appended at the end in its
// original fused order — a parse hiccup must never silently drop a chunk.
function parseRankedOrder(raw: string, count: number): number[] {
  const seen = new Set<number>()
  const order: number[] = []
  for (const match of raw.matchAll(/\d+/g)) {
    const n = Number(match[0])
    if (n >= 1 && n <= count && !seen.has(n)) {
      seen.add(n)
      order.push(n)
    }
  }
  for (let n = 1; n <= count; n++) {
    if (!seen.has(n)) order.push(n)
  }
  return order
}

/**
 * WP-3.2 rerank stage: an LLM listwise reranking pass over the RRF-fused
 * hybrid candidates, reordering by actual relevance to the question rather
 * than RRF's rank-fusion score alone (which fuses lexical/vector rank, not
 * "does this passage answer the question"). Never throws — any failure (no
 * provider configured, timeout, unparseable response) falls back to the
 * original fused order, the same fail-open pattern as queryRewrite.ts.
 */
export async function rerankChunks(
  chatbotId: string,
  question: string,
  candidates: FusedChunk[],
  topN: number,
): Promise<FusedChunk[]> {
  if (candidates.length <= 1) return candidates.slice(0, topN)
  if (!env.retrievalRerankEnabled) return candidates.slice(0, topN)

  try {
    const usageSink: AiUsage[] = []
    const raw = await completeCheaply(rerankPrompt(question, candidates), "Output the ranking now.", usageSink, cheapCallAuthorizer(chatbotId))
    if (usageSink.length > 0) await recordUsage(chatbotId, usageSink)

    if (!raw) {
      log().warn({ chatbotId }, "rerank returned nothing, falling back to fused order")
      return candidates.slice(0, topN)
    }

    const order = parseRankedOrder(raw, candidates.length)
    const reranked = order.map((n) => candidates[n - 1])

    log().info({ chatbotId, candidateCount: candidates.length, topN }, "hybrid retrieval reranked")
    return reranked.slice(0, topN)
  } catch (err) {
    log().warn(
      { chatbotId, err: err instanceof Error ? err.message : String(err) },
      "rerank failed, falling back to fused order",
    )
    return candidates.slice(0, topN)
  }
}
