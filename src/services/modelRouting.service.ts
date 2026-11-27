import { env } from "../env.js"
import { pool } from "../lib/db.js"
import { isUuid } from "../lib/tenantContext.js"
import { log } from "../lib/logger.js"
import { isCircuitOpen } from "../lib/circuitBreaker.js"
import { currentRequestId } from "../lib/requestContext.js"
import type { ModelKey } from "../lib/plans.js"
import type { Entitlement } from "./billing.service.js"
import { cheapestAvailableProvider } from "./modelCosts.service.js"
import { recordRoutingEvent, type RoutingReason } from "./routingEvents.service.js"
import * as usageService from "./usage.service.js"
import { isModelQuotaAvailable } from "./usage.service.js"

export type RoutingDecisionReason = "preferred" | "circuit_open" | "cost_switching" | "fallback" | "exhausted"

export type ModelRoutingPolicy = {
  preferredModel: ModelKey | null
  fallbackChain: ModelKey[]
  costSwitchingEnabled: boolean
  costSwitchingThreshold: number
}

export type ModelRoutingDecision = {
  provider: ModelKey
  reason: RoutingDecisionReason
  requested: ModelKey | null
}

const DEFAULT_CHAIN: ModelKey[] = env.modelPriorityOrder.filter(
  (m): m is ModelKey => m === "openai" || m === "anthropic" || m === "gemini",
)

function asModelKey(value: unknown): ModelKey | null {
  return value === "openai" || value === "anthropic" || value === "gemini" ? value : null
}

export async function loadRoutingPolicy(chatbotId: string, preferredModel?: ModelKey | null): Promise<ModelRoutingPolicy> {
  let fallbackChain = DEFAULT_CHAIN
  let costSwitchingEnabled = true
  let costSwitchingThreshold = 0.2
  if (pool && isUuid(chatbotId)) {
    try {
      const { rows } = await pool.query<{
        preferred_model: string
        fallback_chain: unknown
        cost_switching_enabled: boolean
        cost_switching_threshold: string
      }>(
        `select preferred_model, fallback_chain, cost_switching_enabled, cost_switching_threshold
           from model_routing_configs where chatbot_id = $1`,
        [chatbotId],
      )
      if (rows[0]) {
        const chain = Array.isArray(rows[0].fallback_chain)
          ? (rows[0].fallback_chain as unknown[]).map(asModelKey).filter((k): k is ModelKey => k != null)
          : DEFAULT_CHAIN
        fallbackChain = chain.length > 0 ? chain : DEFAULT_CHAIN
        costSwitchingEnabled = rows[0].cost_switching_enabled
        costSwitchingThreshold = Number(rows[0].cost_switching_threshold) || 0.2
      }
    } catch {
      // Table may not exist yet on an un-migrated database; use defaults.
    }
  }
  return {
    preferredModel: preferredModel ?? null,
    fallbackChain,
    costSwitchingEnabled,
    costSwitchingThreshold,
  }
}

async function remainingCreditRatio(
  chatbotId: string,
  entitlement: Entitlement,
  model: ModelKey,
): Promise<number> {
  try {
    const usage = usageService as {
      getModelPeriodCostUsd?: (chatbotId: string, model: ModelKey, period: "month") => Promise<number>
      getEffectiveModelCapUsd?: (
        chatbotId: string,
        entitlement: Entitlement,
        model: ModelKey,
        period: "month",
      ) => Promise<number>
    }
    if (typeof usage.getModelPeriodCostUsd !== "function" || typeof usage.getEffectiveModelCapUsd !== "function") {
      return 1
    }
    const [spent, cap] = await Promise.all([
      usage.getModelPeriodCostUsd(chatbotId, model, "month"),
      usage.getEffectiveModelCapUsd(chatbotId, entitlement, model, "month"),
    ])
    if (!(cap > 0)) return 0
    return Math.max(0, (cap - spent) / cap)
  } catch {
    return 1
  }
}

async function circuitIsOpen(provider: ModelKey): Promise<boolean> {
  try {
    return await isCircuitOpen(provider)
  } catch {
    return false
  }
}

async function firstHealthy(
  chatbotId: string,
  entitlement: Entitlement,
  candidates: ModelKey[],
): Promise<ModelKey | null> {
  for (const provider of candidates) {
    if (!entitlement.allowedModels.includes(provider)) continue
    if (await circuitIsOpen(provider)) continue
    if (!(await isModelQuotaAvailable(chatbotId, entitlement, provider))) continue
    return provider
  }
  return null
}

export async function decideModelRoute(input: {
  chatbotId: string
  entitlement: Entitlement
  preferredModel?: ModelKey | null
}): Promise<ModelRoutingDecision | null> {
  const policy = await loadRoutingPolicy(input.chatbotId, input.preferredModel)
  const allowed = input.entitlement.allowedModels.filter((m): m is ModelKey =>
    m === "openai" || m === "anthropic" || m === "gemini",
  )
  const requested = policy.preferredModel && allowed.includes(policy.preferredModel) ? policy.preferredModel : null

  const chain = [
    ...(requested ? [requested] : []),
    ...policy.fallbackChain.filter((m) => m !== requested),
  ]

  let reason: RoutingDecisionReason = requested ? "preferred" : "fallback"

  if (requested && (await circuitIsOpen(requested))) {
    reason = "circuit_open"
  } else if (requested && policy.costSwitchingEnabled) {
    const remaining = await remainingCreditRatio(input.chatbotId, input.entitlement, requested)
    if (remaining < policy.costSwitchingThreshold) {
      const cheapest = await cheapestAvailableProvider(allowed).catch(() => null)
      if (cheapest && cheapest !== requested && !(await circuitIsOpen(cheapest))) {
        const available = await isModelQuotaAvailable(input.chatbotId, input.entitlement, cheapest)
        if (available) {
          logRouting(input.chatbotId, requested, cheapest, "cost_switching")
          return { provider: cheapest, reason: "cost_switching", requested }
        }
      }
      reason = "cost_switching"
    }
  }

  const selected = await firstHealthy(input.chatbotId, input.entitlement, chain)
  if (!selected) {
    logRouting(input.chatbotId, requested, null, "exhausted")
    return null
  }
  if (selected !== requested) {
    reason = reason === "preferred" ? "fallback" : reason
  }
  logRouting(input.chatbotId, requested, selected, reason)
  return { provider: selected, reason, requested }
}

function logRouting(
  chatbotId: string,
  requested: ModelKey | null,
  selected: ModelKey | null,
  reason: RoutingDecisionReason,
): void {
  log().info(
    {
      event: "model_routing_decision",
      chatbotId,
      requested,
      selected,
      reason,
    },
    "model routing decision",
  )
  if (!isUuid(chatbotId)) return
  const mapped: RoutingReason =
    reason === "preferred"
      ? requested
        ? "USER_SELECTED"
        : "INITIAL_SELECTION"
      : reason === "circuit_open"
        ? "CIRCUIT_OPEN"
        : reason === "cost_switching"
          ? "COST_SWITCH"
          : reason === "exhausted"
            ? "FALLBACK_DENIED"
            : "QUOTA_SWITCH"
  void recordRoutingEvent({
    requestId: currentRequestId() ?? crypto.randomUUID(),
    chatbotId,
    previousModel: requested,
    selectedModel: selected ?? "none",
    reason: mapped,
  })
}
