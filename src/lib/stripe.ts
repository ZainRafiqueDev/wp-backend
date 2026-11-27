import Stripe from "stripe"

import { env, hasStripe } from "../env.js"
import { AppError } from "./errors.js"

let client: Stripe | null = null


export function stripeClient(): Stripe {
  if (!hasStripe) {
    throw new AppError(503, "Stripe is not configured. Set STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET.")
  }
  if (!client) {
    client = new Stripe(env.stripeSecretKey)
  }
  return client
}


export type PlanTier = "crawl_plus" | "full_custom"


export function priceIdForPlan(plan: PlanTier): string {
  const map: Record<PlanTier, string> = {
    crawl_plus: env.stripePriceCrawlPlus,
    full_custom: env.stripePriceFullCustom,
  }
  const priceId = map[plan]
  if (!priceId) {
    throw new AppError(503, `Stripe price id for the "${plan}" plan is not configured.`)
  }
  return priceId
}


export function planForPriceId(priceId: string): PlanTier | null {
  const entries: [PlanTier, string][] = [
    ["crawl_plus", env.stripePriceCrawlPlus],
    ["full_custom", env.stripePriceFullCustom],
  ]
  const match = entries.find(([, id]) => id && id === priceId)
  return match ? match[0] : null
}

export type TopupModel = "anthropic" | "openai" | "gemini"

export function priceIdForTopupModel(model: TopupModel): string {
  const map: Record<TopupModel, string> = {
    anthropic: env.stripePriceTopupAnthropic,
    openai: env.stripePriceTopupOpenai,
    gemini: env.stripePriceTopupGemini,
  }
  const priceId = map[model]
  if (!priceId) {
    throw new AppError(503, `Stripe top-up price id for "${model}" is not configured.`)
  }
  return priceId
}
