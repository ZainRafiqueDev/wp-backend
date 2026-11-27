
import { pool } from "../lib/db.js"
import { AppError } from "../lib/errors.js"
import { log } from "../lib/logger.js"
import { getDecryptedWooCommerceCredentials } from "./commerceCredentials.service.js"
import { resyncSingleProduct } from "./productCatalog.service.js"
import { transitionOrderState } from "./orderState.service.js"

function requireDbPool() {
  if (!pool) throw new AppError(503, "Database is not configured. Set DATABASE_URL and JWT_SECRET.")
  return pool
}

export async function processCommerceWebhookEvent(chatbotId: string, eventId: string): Promise<void> {
  const db = requireDbPool()
  const { rows } = await db.query("select * from commerce_webhook_events where id = $1 and chatbot_id = $2", [eventId, chatbotId])
  const event = rows[0]
  if (!event) {
    log().warn({ chatbotId, eventId }, "commerce webhook processing: event row not found")
    return
  }
  if (event.processed_at) {
    
    return
  }

  const topic = event.event_type as string
  const payload = event.payload as Record<string, unknown>

  try {
    if (topic.startsWith("product.") && payload.id !== undefined) {
      const creds = await getDecryptedWooCommerceCredentials(chatbotId)
      if (creds) {
        await resyncSingleProduct(chatbotId, creds, Number(payload.id))
        log().info({ chatbotId, eventId, topic, productId: payload.id }, "commerce webhook: product re-synced")
      } else {
        log().warn({ chatbotId, eventId }, "commerce webhook: product event received but no WooCommerce credentials configured")
      }
    } else if (topic.startsWith("order.") && payload.id !== undefined) {
     
      const { rows: orderRows } = await db.query(
        "select id, status from commerce_orders where chatbot_id = $1 and woocommerce_order_id = $2",
        [chatbotId, String(payload.id)],
      )
      const order = orderRows[0]
      if (order && order.status === "PENDING_PAYMENT") {
        await transitionOrderState(order.id, "PAID", { source: "webhook" })
      } else if (!order) {
        log().info({ chatbotId, eventId, woocommerceOrderId: payload.id }, "commerce webhook: order event for an order not created through this pipeline, ignored")
      }
    } else {
      log().info({ chatbotId, eventId, topic }, "commerce webhook: no handler for this event type")
    }

    await db.query("update commerce_webhook_events set processed_at = now() where id = $1", [eventId])
  } catch (err) {
   
    log().error({ chatbotId, eventId, topic, err: err instanceof Error ? err.message : String(err) }, "commerce webhook processing failed")
    throw err
  }
}
