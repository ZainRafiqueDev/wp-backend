import type { Request, Response } from "express"

import { env } from "../env.js"
import type { CalendlyInviteeCreatedPayload } from "../lib/calendly.js"
import { verifyCalendlySignature } from "../lib/calendly.js"
import { log } from "../lib/logger.js"
import { runWithSystemContext } from "../lib/tenantContext.js"
import { recordSecurityEvent } from "../services/securityAudit.service.js"
import { markLeadBookedByEmail } from "../services/lead.service.js"

// Structured identically to postStripeWebhook (billing.controller.ts):
// config-present check → raw-body + signature check → verify → process →
// 200. Always 200s once the signature is valid (even for event types we
// don't care about, or a lead-match miss) so Calendly doesn't treat this
// as a delivery failure and retry forever.
export async function postCalendlyWebhook(req: Request, res: Response) {
  // Read at request time so tests can set the key without a process restart.
  if (!env.calendlyWebhookSigningKey) {
    res.status(503).json({ ok: false, error: "Calendly webhook is not configured." })
    return
  }

  if (!Buffer.isBuffer(req.body)) {
    res.status(400).json({ ok: false, error: "Missing raw body." })
    return
  }

  const signatureHeader = req.headers["calendly-webhook-signature"]
  const valid = verifyCalendlySignature(
    req.body,
    typeof signatureHeader === "string" ? signatureHeader : undefined,
    env.calendlyWebhookSigningKey,
  )
  if (!valid) {
    log().warn("calendly webhook signature rejected")
    void recordSecurityEvent({
      eventType: "webhook_signature_failed",
      requestPath: "/webhooks/calendly",
      ipAddress: req.ip,
      details: { provider: "calendly" },
    })
    res.status(400).json({ ok: false, error: "Webhook signature verification failed." })
    return
  }

  let event: CalendlyInviteeCreatedPayload
  try {
    event = JSON.parse(req.body.toString("utf8"))
  } catch {
    res.status(400).json({ ok: false, error: "Invalid JSON body." })
    return
  }

  if (event.event === "invitee.created" && event.payload?.email) {
    const email = event.payload.email
    const uri = event.payload.uri ?? null
    const meetingStartsAt = event.payload.scheduled_event?.start_time ?? null
    const meetingName = event.payload.scheduled_event?.name ?? null
    try {
      await runWithSystemContext(() => markLeadBookedByEmail(email, uri, meetingStartsAt, meetingName))
    } catch (err) {
      log().error({ err: err instanceof Error ? err.message : String(err) }, "calendly webhook processing failed")
      res.status(500).json({ ok: false, error: "Failed to process webhook event." })
      return
    }
  }

  res.status(200).json({ received: true })
}
