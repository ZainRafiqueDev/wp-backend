import { env } from "../env.js"
import { log } from "./logger.js"
import { cacheRedis } from "./redis.js"

export type RetrievalMode = "hybrid" | "vector"

export type RankedChunk = {
  id: string
  content: string
  fileName: string
  source: "lexical" | "vector"
  rank: number
}

export type FusedChunk = {
  id: string
  content: string
  fileName: string
  score: number
  lexicalRank: number | null
  vectorRank: number | null
}

export type RetrievalMetricName = "retrieval.lexical_hits" | "retrieval.vector_hits" | "retrieval.empty"

export function resolveRetrievalMode(): RetrievalMode {
  return env.retrievalMode === "vector" ? "vector" : "hybrid"
}

export function reciprocalRankScore(rank: number, rrfK: number): number {
  return 1 / (rrfK + rank)
}

/** Union lexical and vector ranked lists with reciprocal-rank fusion. Ties keep first-seen content. */
export function fuseLexicalAndVector(lexical: RankedChunk[], vector: RankedChunk[], rrfK: number): FusedChunk[] {
  const merged = new Map<string, FusedChunk>()

  for (const chunk of lexical) {
    const score = reciprocalRankScore(chunk.rank, rrfK)
    merged.set(chunk.id, {
      id: chunk.id,
      content: chunk.content,
      fileName: chunk.fileName,
      score,
      lexicalRank: chunk.rank,
      vectorRank: null,
    })
  }

  for (const chunk of vector) {
    const score = reciprocalRankScore(chunk.rank, rrfK)
    const existing = merged.get(chunk.id)
    if (existing) {
      existing.score += score
      existing.vectorRank = chunk.rank
      continue
    }
    merged.set(chunk.id, {
      id: chunk.id,
      content: chunk.content,
      fileName: chunk.fileName,
      score,
      lexicalRank: null,
      vectorRank: chunk.rank,
    })
  }

  return [...merged.values()].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
}

export async function incrementRetrievalMetric(
  name: RetrievalMetricName,
  fields: Record<string, unknown> = {},
): Promise<void> {
  log().info({ event: name, metric: name, ...fields }, name)
  try {
    const day = new Date().toISOString().slice(0, 10)
    const key = `metric:${name}:${day}`
    await cacheRedis.incr(key)
    await cacheRedis.expire(key, 3 * 24 * 60 * 60)
  } catch {
    // Metrics must never take retrieval down.
  }
}
