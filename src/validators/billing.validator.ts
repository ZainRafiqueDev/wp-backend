import { z } from "zod"

// full_custom deliberately excluded — that plan no longer has self-service
// checkout (see lead.service.ts's lead-capture + Calendly flow that
// replaced it). This only blocks NEW checkout-session creation; it doesn't
// touch lib/stripe.ts's PlanTier/priceIdForPlan/planForPriceId, which stay
// as-is so an existing or manually-provisioned Full Custom subscription's
// webhook still resolves correctly.
export const createCheckoutSessionSchema = z.object({
  plan: z.enum(["crawl_plus"]),
})

export type CreateCheckoutSessionInput = z.infer<typeof createCheckoutSessionSchema>


export const createTopupSessionSchema = z.object({
  // Matches lib/ai.ts's AiUsage.provider strings exactly.
  model: z.enum(["anthropic", "openai", "gemini"]),
})

export type CreateTopupSessionInput = z.infer<typeof createTopupSessionSchema>
