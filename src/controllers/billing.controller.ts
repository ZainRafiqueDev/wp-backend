import type { Request, Response } from "express"

import { asyncHandler } from "../middleware/asyncHandler.js"
import { hasStripe } from "../env.js"
import { AppError } from "../lib/errors.js"
import { getBearerToken } from "../middleware/requireAuth.js"
import {
  createBillingPortalSession,
  createCheckoutSession,
  getBillingSummary,
  verifyStripeWebhookSignature,
} from "../services/billing.service.js"
import { receiveVerifiedStripeEvent } from "../services/stripeWebhookInbox.service.js"
import { log } from "../lib/logger.js"
import { recordSecurityEvent } from "../services/securityAudit.service.js"
import { createTopupCheckoutSession } from "../services/topup.service.js"
import type { CreateCheckoutSessionInput, CreateTopupSessionInput } from "../validators/billing.validator.js"

function chatbotIdParam(req: Request): string {
  const value = req.params.chatbotId
  return Array.isArray(value) ? value[0] : value
}

export const getSummary = asyncHandler(async (req: Request, res: Response) => {
  const summary = await getBillingSummary(getBearerToken(req))
  res.status(200).json({ ok: true, billing: summary })
})

export const postCheckoutSession = asyncHandler(async (req: Request, res: Response) => {
  const session = await createCheckoutSession(getBearerToken(req), req.body as CreateCheckoutSessionInput)
  res.status(200).json({ ok: true, url: session.url })
})

export const postPortalSession = asyncHandler(async (req: Request, res: Response) => {
  const session = await createBillingPortalSession(getBearerToken(req))
  res.status(200).json({ ok: true, url: session.url })
})

export const postTopupSession = asyncHandler(async (req: Request, res: Response) => {
  const session = await createTopupCheckoutSession(getBearerToken(req), chatbotIdParam(req), req.body as CreateTopupSessionInput)
  res.status(200).json({ ok: true, url: session.url })
})


export async function postStripeWebhook(req: Request, res: Response) {
  
  if (!hasStripe) {
    res.status(503).json({ ok: false, error: "Stripe is not configured." })
    return
  }

  const signature = req.headers["stripe-signature"]
  if (typeof signature !== "string" || !Buffer.isBuffer(req.body)) {
    res.status(400).json({ ok: false, error: "Missing or invalid Stripe signature." })
    return
  }

  let event
  try {
    event = verifyStripeWebhookSignature(req.body, signature)
  } catch (err) {
    log().warn({ err: err instanceof Error ? err.message : String(err) }, "stripe webhook signature rejected")
    void recordSecurityEvent({
      eventType: "webhook_signature_failed",
      requestPath: "/webhooks/stripe",
      ipAddress: req.ip,
      details: { provider: "stripe" },
    })
    res.status(400).json({ ok: false, error: "Webhook signature verification failed." })
    return
  }

  try {
    // Phase 1: persist then process inline before 200. See docs/STRIPE_WEBHOOK_INBOX.md.
    const outcome = await receiveVerifiedStripeEvent(event)
    if (outcome === "in_progress") {
      // Another delivery of this event id holds the processing claim. A
      // non-2xx makes Stripe retry later instead of us acknowledging an
      // event whose processing may still fail.
      res.status(409).json({ ok: false, error: "This event is already being processed." })
      return
    }
  } catch (err) {
    log().error(
      { event: event.type, err: err instanceof Error ? err.message : String(err) },
      "stripe webhook processing failed",
    )
    if (err instanceof AppError) {
      res.status(err.status).json({ ok: false, error: err.message })
      return
    }
    res.status(500).json({ ok: false, error: "Failed to process webhook event." })
    return
  }

  res.status(200).json({ received: true })
}
