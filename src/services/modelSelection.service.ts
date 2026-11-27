import { log } from "../lib/logger.js"
import type { ModelKey } from "../lib/plans.js"
import { currentRequestId } from "../lib/requestContext.js"
import { getEntitlementForChatbot } from "./billing.service.js"
import { decideModelRoute } from "./modelRouting.service.js"
import { recordRoutingEvent } from "./routingEvents.service.js"
import { isModelQuotaAvailable } from "./usage.service.js"
import { env } from "../env.js"

export interface ModelSelection {
  provider: ModelKey
}

export async function selectModelForNewConversation(chatbotId: string, recordEvent = true): Promise<ModelSelection | null> {
  return selectModelForConversation(chatbotId, null, recordEvent)
}

export async function selectModelForConversation(
  chatbotId: string,
  preferredModel?: ModelKey | null,
  recordEvent = true,
): Promise<ModelSelection | null> {
  try {
    const entitlement = await getEntitlementForChatbot(chatbotId)
    const decision = await decideModelRoute({ chatbotId, entitlement, preferredModel })
    if (decision) {
      log().info(
        { chatbotId, provider: decision.provider, reason: decision.reason, event: "model-selected" },
        "model selected for conversation",
      )
      return { provider: decision.provider }
    }
    log().warn({ chatbotId }, "all allowed models exhausted or circuit-open for this billing period")
    return null
  } catch (err) {
    log().warn(
      { chatbotId, preferredModel, err: err instanceof Error ? err.message : String(err), event: "preferred-model-fallback", reason: "error" },
      "error during model routing, falling back to auto selection",
    )
    return fallbackAutoChain(chatbotId, recordEvent)
  }
}

async function fallbackAutoChain(chatbotId: string, recordEvent: boolean): Promise<ModelSelection | null> {
  const entitlement = await getEntitlementForChatbot(chatbotId)
  const allowed = new Set(entitlement.allowedModels)
  const candidates = env.modelPriorityOrder.filter((m): m is ModelKey => allowed.has(m as ModelKey))
  for (const provider of candidates) {
    const available = await isModelQuotaAvailable(chatbotId, entitlement, provider)
    if (available) {
      if (recordEvent) {
        void recordRoutingEvent({
          requestId: currentRequestId() ?? crypto.randomUUID(),
          chatbotId,
          selectedModel: provider,
          reason: "INITIAL_SELECTION",
        })
      }
      return { provider }
    }
  }
  return null
}
