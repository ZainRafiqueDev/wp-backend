import { pool } from "../lib/db.js"
import { log } from "../lib/logger.js"
import { runWithSystemContext } from "../lib/tenantContext.js"
import type { ModelRate } from "../lib/aiPricing.js"
import { env } from "../env.js"
import type { ModelKey } from "../lib/plans.js"

export type ModelCostRow = {
  provider: ModelKey
  modelId: string
  inputCostPer1k: number
  outputCostPer1k: number
  contextWindowTokens: number
  isAvailable: boolean
}

let cache: Map<string, ModelRate> | null = null
let cacheLoadedAt = 0
const CACHE_TTL_MS = 60_000

export async function refreshModelCostCache(): Promise<void> {
  if (!pool) {
    cache = null
    return
  }
  try {
    const rows = await runWithSystemContext(async () => {
      const { rows: found } = await pool!.query<{
        provider: string
        model_id: string
        input_cost_per_1k_tokens: string
        output_cost_per_1k_tokens: string
      }>(
        `select distinct on (provider, model_id)
            provider, model_id, input_cost_per_1k_tokens, output_cost_per_1k_tokens
           from model_costs
          where is_available
          order by provider, model_id, effective_from desc`,
      )
      return found
    })
    const next = new Map<string, ModelRate>()
    for (const row of rows) {
      const perMillionInput = Number(row.input_cost_per_1k_tokens) * 1000
      const perMillionOutput = Number(row.output_cost_per_1k_tokens) * 1000
      next.set(row.model_id, { inputPerMillion: perMillionInput, outputPerMillion: perMillionOutput })
    }
    cache = next
    cacheLoadedAt = Date.now()
  } catch (err) {
    log().warn(
      { err: err instanceof Error ? err.message : String(err) },
      "model_costs cache refresh failed — using hardcoded rates",
    )
  }
}

export function cachedRateForModel(modelId: string): ModelRate | null {
  if (!cache || Date.now() - cacheLoadedAt > CACHE_TTL_MS) return null
  return cache.get(modelId) ?? null
}

export async function listModelCosts(): Promise<ModelCostRow[]> {
  if (!pool) return []
  return runWithSystemContext(async () => {
    const { rows } = await pool!.query(
      `select distinct on (provider, model_id)
          provider, model_id, input_cost_per_1k_tokens, output_cost_per_1k_tokens,
          context_window_tokens, is_available
         from model_costs
        order by provider, model_id, effective_from desc`,
    )
    return rows.map((row) => ({
      provider: row.provider as ModelKey,
      modelId: row.model_id as string,
      inputCostPer1k: Number(row.input_cost_per_1k_tokens),
      outputCostPer1k: Number(row.output_cost_per_1k_tokens),
      contextWindowTokens: Number(row.context_window_tokens),
      isAvailable: Boolean(row.is_available),
    }))
  })
}

const FALLBACK_COST_ORDER: ModelKey[] = ["gemini", "openai", "anthropic"]

export async function cheapestAvailableProvider(allowed: ModelKey[]): Promise<ModelKey | null> {
  const costs = await listModelCosts()
  const byProvider = new Map<ModelKey, number>()
  for (const row of costs) {
    if (!row.isAvailable || !allowed.includes(row.provider)) continue
    const blended = row.inputCostPer1k + row.outputCostPer1k
    const existing = byProvider.get(row.provider)
    if (existing == null || blended < existing) byProvider.set(row.provider, blended)
  }
  const ranked = [...byProvider.entries()].sort((a, b) => a[1] - b[1])
  if (ranked[0]) return ranked[0][0]
  return FALLBACK_COST_ORDER.find((key) => allowed.includes(key)) ?? allowed[0] ?? null
}

export function defaultModelIdForProvider(provider: ModelKey): string {
  if (provider === "openai") return env.openaiModel
  if (provider === "anthropic") return env.anthropicModel
  return env.geminiModel
}
