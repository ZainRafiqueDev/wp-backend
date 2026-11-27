import { env } from "../env.js"
import { log } from "./logger.js"
import { cachedRateForModel } from "../services/modelCosts.service.js"

export interface ModelRate {
  inputPerMillion: number
  outputPerMillion: number
}


const DEFAULT_RATES: Record<string, ModelRate> = {
  "claude-sonnet-5": { inputPerMillion: 3, outputPerMillion: 15 },
  "gpt-4o-mini": { inputPerMillion: 0.15, outputPerMillion: 0.6 },
  "gemini-flash-latest": { inputPerMillion: 0.075, outputPerMillion: 0.3 },
}


const ZERO_RATE: ModelRate = { inputPerMillion: 0, outputPerMillion: 0 }
const KNOWN_FREE_MODELS = new Set<string>([env.ollamaModel])

function loadOverrides(): Record<string, ModelRate> {
  if (!env.aiPricingOverridesJson) return {}
  try {
    const parsed = JSON.parse(env.aiPricingOverridesJson) as Record<string, ModelRate>
    log().info({ models: Object.keys(parsed) }, "loaded AI pricing overrides")
    return parsed
  } catch (err) {
    log().warn(
      { err: err instanceof Error ? err.message : String(err) },
      "AI_PRICING_OVERRIDES_JSON is not valid JSON, ignoring",
    )
    return {}
  }
}

const RATES: Record<string, ModelRate> = { ...DEFAULT_RATES, ...loadOverrides() }

export function estimateCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const cached = cachedRateForModel(model)
  const rate = cached ?? RATES[model] ?? (KNOWN_FREE_MODELS.has(model) ? ZERO_RATE : null)
  if (!rate) {
    log().warn({ model }, "no AI pricing rate configured for this model, estimating $0 cost")
    return 0
  }
  return (inputTokens / 1_000_000) * rate.inputPerMillion + (outputTokens / 1_000_000) * rate.outputPerMillion
}

const PROVIDER_MODELS: Record<string, () => string> = {
  anthropic: () => env.anthropicModel,
  openai: () => env.openaiModel,
  gemini: () => env.geminiModel,
}

/**
 * Conservative pre-call hold used by the atomic quota check.
 *
 * The old fixed $0.05 hold equalled the Free plan's entire daily cap, so one
 * cheap gpt-4o-mini reply blocked that provider for the rest of the day. This
 * estimate scales with the request and is bounded to keep both tiny and
 * unexpectedly large prompts safe.
 */
export function estimateReservationUsd(provider: string, inputTokens: number, maxOutputTokens = 800): number {
  const model = PROVIDER_MODELS[provider]?.()
  if (!model || !RATES[model]) {
    log().error({ provider, model }, "cannot reserve AI spend without a configured model price")
    return Number.POSITIVE_INFINITY
  }

  const estimated = estimateCostUsd(model, inputTokens, maxOutputTokens) * env.reservationEstimateMultiplier
  return Math.max(env.minPerCallCostReservationUsd, estimated)
}
