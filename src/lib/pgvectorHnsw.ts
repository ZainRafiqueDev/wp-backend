import type { Pool, PoolClient } from "pg"

import { env } from "../env.js"
import { pool } from "./db.js"
import { log } from "./logger.js"
import { cacheRedis } from "./redis.js"

export const DOCUMENT_CHUNKS_HNSW_INDEX = "idx_chatbot_document_chunks_embedding_hnsw"
export const PRODUCT_CATALOG_HNSW_INDEX = "idx_product_catalog_cache_embedding_hnsw"

export interface HnswIndexHealth {
  available: boolean
  documentChunks: boolean
  productCatalog: boolean
}

export async function getHnswIndexHealth(): Promise<HnswIndexHealth> {
  const missing = { available: false, documentChunks: false, productCatalog: false }
  if (!pool) return missing
  try {
    const { rows } = await pool.query<{ indexname: string }>(
      `select indexname
       from pg_indexes
       where schemaname = 'public'
         and indexname = any($1::text[])`,
      [[DOCUMENT_CHUNKS_HNSW_INDEX, PRODUCT_CATALOG_HNSW_INDEX]],
    )
    const names = new Set(rows.map((row) => row.indexname))
    return {
      available: true,
      documentChunks: names.has(DOCUMENT_CHUNKS_HNSW_INDEX),
      productCatalog: names.has(PRODUCT_CATALOG_HNSW_INDEX),
    }
  } catch (err) {
    log().warn({ err: err instanceof Error ? err.message : String(err) }, "hnsw index health query failed")
    return missing
  }
}

export async function applyHnswSearchSettings(client: PoolClient): Promise<void> {
  try {
    await client.query("select set_config('hnsw.ef_search', $1, true)", [String(env.pgvectorHnswEfSearch)])
  } catch (err) {
    log().warn(
      { err: err instanceof Error ? err.message : String(err) },
      "hnsw.ef_search is unavailable; continuing with the server default",
    )
  }
}

export async function withHnswSearch<T>(db: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect()
  try {
    await client.query("begin")
    await applyHnswSearchSettings(client)
    const result = await fn(client)
    await client.query("commit")
    return result
  } catch (err) {
    await client.query("rollback").catch(() => undefined)
    throw err
  } finally {
    client.release()
  }
}

export interface RetrievalObservation {
  elapsedMs: number
  returned: number
  limit: number
  distances?: number[]
}

/** Operator guidance. Lookups still honor PGVECTOR_HNSW_EF_SEARCH, not this table. */
export function recommendedHnswEfSearch(vectorCount: number): number {
  if (vectorCount < 1_000) return 20
  if (vectorCount < 50_000) return 40
  return 80
}

export async function recordRetrievalObservation(
  kind: "document" | "product",
  observation: RetrievalObservation,
): Promise<void> {
  const similarities = (observation.distances ?? []).map((distance) => 1 - distance)
  const avgSimilarity =
    similarities.length > 0 ? similarities.reduce((sum, value) => sum + value, 0) / similarities.length : null
  const hit = observation.returned > 0
  const day = new Date().toISOString().slice(0, 10)
  const metric = kind === "document" ? "retrieval.document_lookup" : "retrieval.product_lookup"
  log().info(
    {
      event: metric,
      metric,
      elapsedMs: observation.elapsedMs,
      returned: observation.returned,
      limit: observation.limit,
      hit,
      avgSimilarity,
    },
    metric,
  )
  try {
    await cacheRedis.incrby(`metric:${metric}_ms:${day}`, Math.max(0, Math.round(observation.elapsedMs)))
    await cacheRedis.incr(`metric:${metric}_n:${day}`)
    if (hit) await cacheRedis.incr(`metric:${metric}_hits:${day}`)
    await cacheRedis.incrby(`metric:${metric}_returned:${day}`, observation.returned)
    if (avgSimilarity !== null) {
      await cacheRedis.incrby(`metric:${metric}_similarity_milli:${day}`, Math.round(avgSimilarity * 1000))
      await cacheRedis.incr(`metric:${metric}_similarity_n:${day}`)
    }
    for (const key of [
      `metric:${metric}_ms:${day}`,
      `metric:${metric}_n:${day}`,
      `metric:${metric}_hits:${day}`,
      `metric:${metric}_returned:${day}`,
      `metric:${metric}_similarity_milli:${day}`,
      `metric:${metric}_similarity_n:${day}`,
    ]) {
      await cacheRedis.expire(key, 3 * 24 * 60 * 60)
    }
  } catch {
    // Metrics must never take retrieval down.
  }
}

