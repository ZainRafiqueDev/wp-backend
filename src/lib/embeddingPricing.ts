import { env } from "../env.js"
import { AppError } from "./errors.js"
import { log } from "./logger.js"

/** pgvector column typmod on document chunks and product catalog. */
export const STORED_EMBEDDING_DIM = 1536

export class EmbeddingPriceMissingError extends AppError {
  readonly model: string

  constructor(model: string) {
    super(503, `Embedding model price is not configured for ${model}.`)
    this.name = "EmbeddingPriceMissingError"
    this.model = model
  }
}

export class EmbeddingDimensionError extends AppError {
  constructor(message: string) {
    super(503, message)
    this.name = "EmbeddingDimensionError"
  }
}

const DEFAULT_EMBEDDING_RATES: Record<string, number> = {
  "text-embedding-3-small": 0.02,
  "text-embedding-3-large": 0.13,
  "text-embedding-ada-002": 0.1,
}

const DEFAULT_EMBEDDING_DIMS: Record<string, number> = {
  "text-embedding-3-small": 1536,
  "text-embedding-3-large": 3072,
  "text-embedding-ada-002": 1536,
}

function loadEmbeddingRateOverrides(): Record<string, number> {
  if (!env.embeddingPricingOverridesJson) return {}
  try {
    const parsed = JSON.parse(env.embeddingPricingOverridesJson) as Record<string, { inputPerMillion?: number } | number>
    const rates: Record<string, number> = {}
    for (const [model, value] of Object.entries(parsed)) {
      const rate = typeof value === "number" ? value : value.inputPerMillion
      if (typeof rate === "number" && Number.isFinite(rate) && rate >= 0) rates[model] = rate
    }
    return rates
  } catch (err) {
    log().warn(
      { err: err instanceof Error ? err.message : String(err) },
      "EMBEDDING_PRICING_OVERRIDES_JSON is not valid JSON, ignoring",
    )
    return {}
  }
}

const EMBEDDING_RATES: Record<string, number> = { ...DEFAULT_EMBEDDING_RATES, ...loadEmbeddingRateOverrides() }

export function estimateEmbeddingTokens(text: string): number {
  if (!text) return 0
  return Math.max(1, Math.ceil(text.length / 4))
}

export function estimateEmbeddingTokensForTexts(texts: string[]): number {
  return texts.reduce((sum, text) => sum + estimateEmbeddingTokens(text), 0)
}

export function requireEmbeddingRatePerMillion(model: string): number {
  const rate = EMBEDDING_RATES[model]
  if (rate == null || !Number.isFinite(rate) || rate < 0) {
    throw new EmbeddingPriceMissingError(model)
  }
  return rate
}

export function estimateEmbeddingCostUsd(model: string, tokens: number): number {
  const rate = requireEmbeddingRatePerMillion(model)
  if (!Number.isFinite(tokens) || tokens <= 0) return 0
  return (tokens / 1_000_000) * rate
}

export type EmbeddingIdentity = {
  model: string
  dim: number
}

export function resolveEmbeddingIdentity(): EmbeddingIdentity {
  const model = env.productEmbeddingModel
  const catalogDim = DEFAULT_EMBEDDING_DIMS[model]
  const dim = env.embeddingDim || catalogDim || STORED_EMBEDDING_DIM
  if (dim !== STORED_EMBEDDING_DIM) {
    throw new EmbeddingDimensionError(
      `Embedding dimension ${dim} cannot be stored in the vector(${STORED_EMBEDDING_DIM}) column. Re-embed after a dim migration, or keep a ${STORED_EMBEDDING_DIM}-dim model.`,
    )
  }
  if (catalogDim != null && catalogDim !== dim) {
    throw new EmbeddingDimensionError(
      `Embedding model ${model} produces ${catalogDim} dimensions, not the configured ${dim}.`,
    )
  }
  requireEmbeddingRatePerMillion(model)
  return { model, dim }
}
