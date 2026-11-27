import type { ModelKey } from "../lib/plans.js"
import { AppError } from "../lib/errors.js"
import { getEntitlementForChatbot } from "./billing.service.js"
import { getModelPeriodCreditUsd } from "./usage.service.js"

// Gemini does not support the Custom Action tool loop in ai.ts today.
export const CUSTOM_ACTION_MODELS: ModelKey[] = ["anthropic", "openai"]

export async function requireCrawlPlusCustomActions(chatbotId: string): Promise<void> {
  const entitlement = await getEntitlementForChatbot(chatbotId)
  if (!entitlement.active || entitlement.plan !== "crawl_plus") {
    throw new AppError(402, "Custom Actions require an active Crawl Plus subscription.")
  }
}

export async function getCustomActionTopupModels(chatbotId: string): Promise<ModelKey[]> {
  const entitlement = await getEntitlementForChatbot(chatbotId)
  if (!entitlement.active || entitlement.plan !== "crawl_plus") return []

  const supported = CUSTOM_ACTION_MODELS.filter((model) => entitlement.allowedModels.includes(model))
  const credits = await Promise.all(
    supported.map(async (model) => ({ model, credit: await getModelPeriodCreditUsd(chatbotId, model) })),
  )
  return credits.filter(({ credit }) => credit > 0).map(({ model }) => model)
}

export async function requireCustomActionTopup(chatbotId: string): Promise<ModelKey[]> {
  await requireCrawlPlusCustomActions(chatbotId)
  const models = await getCustomActionTopupModels(chatbotId)
  if (models.length === 0) {
    throw new AppError(
      402,
      "Custom Actions require a current-month Claude or OpenAI model top-up for this chatbot.",
    )
  }
  return models
}
