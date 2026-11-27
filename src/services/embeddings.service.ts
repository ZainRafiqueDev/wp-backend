import { OpenAIEmbeddings } from "@langchain/openai"

import { env, hasProductEmbeddings } from "../env.js"
import {
  EmbeddingBudgetError,
  incrementEmbedMetric,
  releaseEmbeddingBudget,
  reserveEmbeddingBudget,
} from "../lib/embeddingBudget.js"
import {
  EmbeddingDimensionError,
  estimateEmbeddingCostUsd,
  estimateEmbeddingTokensForTexts,
  resolveEmbeddingIdentity,
  STORED_EMBEDDING_DIM,
  type EmbeddingIdentity,
} from "../lib/embeddingPricing.js"
import { log } from "../lib/logger.js"

export type EmbedPurpose = "document_ingest" | "document_query" | "product_sync" | "product_query"

export type EmbedRequest = {
  chatbotId: string
  purpose: EmbedPurpose
}

let client: OpenAIEmbeddings | null = null
let clientModel: string | null = null

function getClient(model: string): OpenAIEmbeddings {
  if (!client || clientModel !== model) {
    client = new OpenAIEmbeddings({ apiKey: env.openaiApiKey, model })
    clientModel = model
  }
  return client
}

export function activeEmbeddingIdentity(): EmbeddingIdentity {
  return resolveEmbeddingIdentity()
}

function assertStoredVectors(vectors: (number[] | null)[], dim: number): void {
  for (const vector of vectors) {
    if (!vector) continue
    if (vector.length !== dim || vector.length !== STORED_EMBEDDING_DIM) {
      throw new EmbeddingDimensionError(
        `Embedding provider returned ${vector.length} dimensions; stored vectors must be ${STORED_EMBEDDING_DIM}.`,
      )
    }
  }
}

async function embedWithBudget(texts: string[], request: EmbedRequest): Promise<(number[] | null)[]> {
  if (!hasProductEmbeddings || texts.length === 0) return texts.map(() => null)

  const identity = resolveEmbeddingIdentity()
  const tokens = estimateEmbeddingTokensForTexts(texts)
  const costUsd = estimateEmbeddingCostUsd(identity.model, tokens)
  const reservation = await reserveEmbeddingBudget({
    chatbotId: request.chatbotId,
    callCount: 1,
    tokenCount: tokens,
    costUsd,
  })

  try {
    const vectors = await getClient(identity.model).embedDocuments(texts)
    assertStoredVectors(vectors, identity.dim)
    await incrementEmbedMetric("embed.calls", {
      chatbotId: request.chatbotId,
      purpose: request.purpose,
      model: identity.model,
      dim: identity.dim,
      tokens,
      costUsd,
      reservedCostUsd: reservation.costUsd,
    })
    return vectors
  } catch (err) {
    await releaseEmbeddingBudget({
      userId: reservation.userId,
      usageDay: reservation.usageDay,
      callCount: 1,
      tokenCount: tokens,
      costUsd,
    }).catch(() => undefined)
    if (err instanceof EmbeddingBudgetError || err instanceof EmbeddingDimensionError) throw err
    log().warn(
      { err: err instanceof Error ? err.message : String(err), count: texts.length, purpose: request.purpose },
      "embedding call failed, falling back to plain SQL match",
    )
    return texts.map(() => null)
  }
}

export async function embedText(text: string, request: EmbedRequest): Promise<number[] | null> {
  const [vector] = await embedTexts([text], request)
  return vector ?? null
}

export async function embedTexts(texts: string[], request: EmbedRequest): Promise<(number[] | null)[]> {
  return embedWithBudget(texts, request)
}

export function toPgVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(",")}]`
}

export { EmbeddingBudgetError } from "../lib/embeddingBudget.js"
export { EmbeddingDimensionError, EmbeddingPriceMissingError } from "../lib/embeddingPricing.js"
