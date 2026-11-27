
import { createHash } from "node:crypto"

import { pool } from "../lib/db.js"
import { AppError } from "../lib/errors.js"
import { log } from "../lib/logger.js"
import { setTenantContext } from "../lib/tenantContext.js"
import { verifyWooCommerceWebhookSignature } from "../lib/woocommerce/webhookSignature.js"
import { getDecryptedWebhookSecret } from "./commerceCredentials.service.js"
import { enqueueCommerceWebhookProcessing } from "../lib/commerceQueue.js"

function requireDbPool() {
  if (!pool) throw new AppError(503, "Database is not configured. Set DATABASE_URL and JWT_SECRET.")
  return pool
}


function deriveProviderEventId(topic: string, payload: Record<string, unknown>, body: Buffer): string {
  const resourceId = payload.id !== undefined ? String(payload.id) : "unknown"
  const modified = typeof payload.date_modified === "string" ? payload.date_modified : createHash("sha256").update(body).digest("hex").slice(0, 16)
  return `${topic}:${resourceId}:${modified}`
}

export interface ReceiveWebhookResult {
  accepted: boolean
  duplicate: boolean
  ping?: boolean
}


const PING_BODY_PATTERN = /^webhook_id=\d+$/

function isWooCommerceValidationPing(body: Buffer): boolean {
  return PING_BODY_PATTERN.test(body.toString("utf8").trim())
}

export async function receiveWooCommerceWebhook(chatbotId: string, rawBody: Buffer | undefined, signatureHeader: string | undefined, topicHeader: string | undefined): Promise<ReceiveWebhookResult> {
  setTenantContext({ scope: "worker", chatbotId })
  const body = rawBody ?? Buffer.alloc(0)

  const secret = await getDecryptedWebhookSecret(chatbotId)
  if (!secret) {
    log().warn({ chatbotId }, "woocommerce webhook received for a chatbot with no configured webhook secret")
    throw new AppError(404, "Not found.")
  }

 
  if (isWooCommerceValidationPing(body)) {
    log().info({ chatbotId }, "woocommerce webhook validation ping received, acknowledged (no signature to check yet)")
    return { accepted: true, duplicate: false, ping: true }
  }

  if (!verifyWooCommerceWebhookSignature(body, signatureHeader, secret)) {
    log().warn(
      { chatbotId, event: "webhook_signature_failed", bodyLength: body.length },
      "woocommerce webhook signature verification failed",
    )
    throw new AppError(401, "Invalid signature.")
  }

  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(body.toString("utf8"))
  } catch {
    throw new AppError(400, "Invalid JSON body.")
  }

  const topic = topicHeader || "unknown"
  const providerEventId = deriveProviderEventId(topic, payload, body)

  const db = requireDbPool()
  const { rows } = await db.query(
    `insert into commerce_webhook_events (chatbot_id, provider_event_id, event_type, payload)
     values ($1, $2, $3, $4)
     on conflict (chatbot_id, provider_event_id) do nothing
     returning id`,
    [chatbotId, providerEventId, topic, JSON.stringify(payload)],
  )

  if (!rows[0]) {
    log().info({ chatbotId, topic, providerEventId }, "woocommerce webhook: duplicate delivery, no reprocessing")
    return { accepted: true, duplicate: true }
  }

  log().info({ chatbotId, topic, providerEventId, eventRowId: rows[0].id }, "woocommerce webhook received and queued for processing")
  await enqueueCommerceWebhookProcessing({ chatbotId, eventId: rows[0].id })
  return { accepted: true, duplicate: false }
}
