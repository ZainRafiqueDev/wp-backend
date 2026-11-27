
import { pool } from "../lib/db.js"
import { AppError } from "../lib/errors.js"
import { log } from "../lib/logger.js"

function requireDbPool() {
  if (!pool) throw new AppError(503, "Database is not configured. Set DATABASE_URL and JWT_SECRET.")
  return pool
}

export interface CustomerNotification {
  id: string
  chatbotId: string
  customerId: string
  orderId: string | null
  type: string
  payload: Record<string, unknown>
}

function mapRow(row: Record<string, unknown>): CustomerNotification {
  return {
    id: row.id as string,
    chatbotId: row.chatbot_id as string,
    customerId: row.customer_id as string,
    orderId: (row.order_id as string | null) ?? null,
    type: row.type as string,
    payload: row.payload as Record<string, unknown>,
  }
}


export async function createPaymentConfirmedNotification(chatbotId: string, customerId: string, orderId: string, bookingNumber: string): Promise<void> {
  const db = requireDbPool()
  await db.query(
    "insert into customer_notifications (chatbot_id, customer_id, order_id, type, payload) values ($1, $2, $3, 'payment_confirmed', $4)",
    [chatbotId, customerId, orderId, JSON.stringify({ bookingNumber, message: `Your payment has been confirmed. Your booking number is ${bookingNumber}.` })],
  )
}


// CS-04: scoped by chatbot as well as customer, and claimed atomically
// (update ... returning) so two concurrent turns can't both deliver the same
// row and one tenant's chat can never deliver another tenant's notification.
export async function drainUndeliveredNotifications(chatbotId: string, customerId: string): Promise<CustomerNotification[]> {
  const db = requireDbPool()
  const { rows } = await db.query(
    `update customer_notifications set delivered_at = now()
     where chatbot_id = $1 and customer_id = $2 and delivered_at is null
     returning *`,
    [chatbotId, customerId],
  )
  if (rows.length === 0) return []
  log().info({ chatbotId, customerId, count: rows.length }, "drained undelivered customer notifications")
  return rows.map(mapRow)
}
