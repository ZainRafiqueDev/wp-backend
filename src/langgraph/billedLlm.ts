import { randomUUID } from "node:crypto"

import type { BaseMessage } from "@langchain/core/messages"

import { env } from "../env.js"
import type { AiUsage } from "../lib/ai.js"
import { estimateCostUsd } from "../lib/aiPricing.js"
import { log } from "../lib/logger.js"
import { getEntitlementForChatbot } from "../services/billing.service.js"
import { recordUsage, reserveModelCostSlot } from "../services/usage.service.js"
import { getCommerceLlm } from "./llm.js"
import { COMMERCE_LLM_MAX_OUTPUT_TOKENS, COMMERCE_LLM_MODEL } from "./llmConfig.js"

// NEW-01: every LLM call the commerce / Bookly / Bookly-admin graphs make
// goes through the same reserve -> call -> commit -> recordUsage path as the
// main answer flow (answerChatbotQuestion.ts). Each call gets its own
// server-generated reservation key (CS-03 denies any reused key), the
// chatbot's per-model, account and platform caps are enforced by
// reserveModelCostSlot, and a denied reservation never reaches the provider.

// Budget key used by reserveModelCostSlot / recordUsage — the same provider
// key the main flow uses for OpenAI, so graph spend lands in the same caps.
const BUDGET_MODEL_KEY = "openai"

export const LLM_BUDGET_DENIED_TEXT = "Sorry, I can't answer that right now. Please try again later or contact us directly."

export class LlmBudgetDeniedError extends Error {
  constructor(public readonly chatbotId: string) {
    super("AI usage reservation denied")
    this.name = "LlmBudgetDeniedError"
  }
}

interface LlmResult {
  content: unknown
  usage_metadata?: { input_tokens?: number; output_tokens?: number }
  response_metadata?: Record<string, unknown>
}

function approxTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

function messagesText(messages: BaseMessage[]): string {
  return messages.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n")
}

// The model that actually answered, as the provider reported it. OpenAI
// returns a dated snapshot ("gpt-4o-mini-2024-07-18"); strip the date so it
// is priced at the configured rate instead of falling through to $0.
function answeringModel(result: LlmResult): string {
  const reported = result?.response_metadata?.model_name ?? result?.response_metadata?.model
  if (typeof reported !== "string" || !reported) return COMMERCE_LLM_MODEL
  return reported.replace(/-\d{4}-\d{2}-\d{2}$/, "")
}

// Provider token counts when present; otherwise a conservative text-length
// estimate, so a response without usage metadata is still billed.
function usageFor(result: LlmResult, promptText: string): AiUsage {
  const reportedIn = result?.usage_metadata?.input_tokens
  const reportedOut = result?.usage_metadata?.output_tokens
  return {
    provider: BUDGET_MODEL_KEY,
    model: answeringModel(result),
    inputTokens: typeof reportedIn === "number" ? reportedIn : approxTokens(promptText),
    outputTokens: typeof reportedOut === "number" ? reportedOut : approxTokens(String(result?.content ?? "")),
  }
}

/**
 * Reserve, call the graph LLM, then reconcile the reservation and record the
 * usage against `chatbotId`. Throws LlmBudgetDeniedError (without calling the
 * provider) when the reservation is denied or cannot be made.
 */
export async function invokeBilledCommerceLlm(chatbotId: string, messages: BaseMessage[]): Promise<LlmResult> {
  const promptText = messagesText(messages)
  const reservationUsd = Math.max(
    env.minPerCallCostReservationUsd,
    estimateCostUsd(COMMERCE_LLM_MODEL, approxTokens(promptText), COMMERCE_LLM_MAX_OUTPUT_TOKENS) * env.reservationEstimateMultiplier,
  )
  const requestId = `langgraph:${randomUUID()}`

  let entitlement: Awaited<ReturnType<typeof getEntitlementForChatbot>>
  let reservation: Awaited<ReturnType<typeof reserveModelCostSlot>>
  try {
    entitlement = await getEntitlementForChatbot(chatbotId)
    reservation = await reserveModelCostSlot(chatbotId, BUDGET_MODEL_KEY, entitlement, requestId, reservationUsd)
  } catch (err) {
    log().error({ chatbotId, err: err instanceof Error ? err.message : String(err) }, "langgraph llm: reservation failed closed")
    throw new LlmBudgetDeniedError(chatbotId)
  }
  if (!reservation.ok) {
    log().info({ chatbotId, model: BUDGET_MODEL_KEY }, "langgraph llm: usage reservation denied, provider not called")
    throw new LlmBudgetDeniedError(chatbotId)
  }

  let usage: AiUsage | null = null
  try {
    const result = (await getCommerceLlm().invoke(messages)) as LlmResult
    usage = usageFor(result, promptText)
    return result
  } finally {
    // A failed provider call reconciles to zero and releases the hold, the
    // same as answerQuestion's fallback loop.
    const actualCostUsd = usage ? estimateCostUsd(usage.model, usage.inputTokens, usage.outputTokens) : 0
    await reservation.commit(actualCostUsd)
    if (usage) await recordUsage(chatbotId, [usage], entitlement)
  }
}

/**
 * Wraps a graph node so a denied reservation ends the turn with a polite
 * reply instead of an error. `onDenied` returns the state update that routes
 * the graph to END (per node). Every other error, including LangGraph's own
 * interrupt signal, is rethrown unchanged.
 */
export function withLlmBudget<S, U, A extends unknown[]>(
  node: (state: S, ...rest: A) => Promise<U>,
  onDenied: (state: S) => U,
): (state: S, ...rest: A) => Promise<U> {
  return async (state: S, ...rest: A) => {
    try {
      return await node(state, ...rest)
    } catch (err) {
      if (err instanceof LlmBudgetDeniedError) return onDenied(state)
      throw err
    }
  }
}
