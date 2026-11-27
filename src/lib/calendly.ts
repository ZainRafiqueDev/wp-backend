import { createHmac, timingSafeEqual } from "node:crypto"

// Calendly signs webhooks as `Calendly-Webhook-Signature: t=<unix-ts>,v1=<hex-hmac>`,
// where v1 = HMAC-SHA256(signingKey, `${t}.${rawBody}`) — same shape of job as
// Stripe's own scheme (billing.service.ts's verifyStripeWebhookSignature),
// just without an SDK to do it for us.
// Audit 2026-11-27: the timestamp was signed but never checked, so a captured
// webhook could be replayed forever. Calendly recommends a few minutes.
export const CALENDLY_SIGNATURE_TOLERANCE_SECONDS = 5 * 60

export function verifyCalendlySignature(
  rawBody: Buffer,
  header: string | undefined,
  signingKey: string,
  nowMs: number = Date.now(),
): boolean {
  if (!header) return false

  const parts = Object.fromEntries(
    header.split(",").map((part) => {
      const [key, value] = part.split("=")
      return [key?.trim(), value?.trim()]
    }),
  )
  const timestamp = parts.t
  const signature = parts.v1
  if (!timestamp || !signature) return false
  if (!/^\d{1,12}$/.test(timestamp)) return false
  if (Math.abs(nowMs / 1000 - Number(timestamp)) > CALENDLY_SIGNATURE_TOLERANCE_SECONDS) return false

  const expected = createHmac("sha256", signingKey).update(`${timestamp}.${rawBody.toString("utf8")}`).digest("hex")

  const expectedBuf = Buffer.from(expected, "hex")
  const actualBuf = Buffer.from(signature, "hex")
  if (expectedBuf.length !== actualBuf.length) return false
  return timingSafeEqual(expectedBuf, actualBuf)
}

export interface CalendlyInviteeCreatedPayload {
  event: string
  payload: {
    email?: string
    name?: string
    uri?: string
    scheduled_event?: {
      name?: string
      start_time?: string
    }
  }
}
