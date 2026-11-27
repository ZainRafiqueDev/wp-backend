import { randomUUID } from "node:crypto"

import type { AuthorizeAttempt } from "./ai.js"
import { estimateReservationUsd } from "./aiPricing.js"
import { log } from "./logger.js"
import { getEntitlementForChatbot, type Entitlement } from "../services/billing.service.js"
import { reserveModelCostSlot } from "../services/usage.service.js"

// NEW-01 (Medium): auxiliary completeCheaply calls (query rewrite, rerank,
// session summary / fact extraction, OKF suggestion) used to be recorded only
// after the provider call, never reserved, so they could run past a cap.
// They now reserve a small fixed hold first, per provider attempt, under a
// fresh server-generated key; completeCheaply reconciles it with the real
// cost, and the caller still records usage with recordUsage as before.
//
// Fixed size: these prompts are bounded (rerank 600 chars x candidates, OKF
// 3000 chars of text, summaries a short transcript), so ~4k input tokens plus
// the 800-token output ceiling covers them; reconciliation corrects the hold
// to the actual cost either way.
export const CHEAP_CALL_RESERVATION_INPUT_TOKENS = 4000
export const CHEAP_CALL_MAX_OUTPUT_TOKENS = 800

export function cheapCallAuthorizer(chatbotId: string): AuthorizeAttempt {
  let entitlement: Promise<Entitlement> | null = null
  return async (provider) => {
    try {
      entitlement ??= getEntitlementForChatbot(chatbotId)
      const reservation = await reserveModelCostSlot(
        chatbotId,
        provider,
        await entitlement,
        `cheap:${randomUUID()}`,
        estimateReservationUsd(provider, CHEAP_CALL_RESERVATION_INPUT_TOKENS, CHEAP_CALL_MAX_OUTPUT_TOKENS),
      )
      if (!reservation.ok) {
        log().info({ chatbotId, provider }, "cheap ai call: usage reservation denied, provider not called")
        return { ok: false }
      }
      return { ok: true, commit: reservation.commit }
    } catch (err) {
      log().error({ chatbotId, provider, err: err instanceof Error ? err.message : String(err) }, "cheap ai call: reservation failed closed")
      return { ok: false }
    }
  }
}
