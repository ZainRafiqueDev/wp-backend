
import { pool } from "../lib/db.js"
import { AppError } from "../lib/errors.js"
import { authorizeToolCall } from "./toolAuthorization.service.js"

function requireDbPool() {
  if (!pool) throw new AppError(503, "Database is not configured. Set DATABASE_URL and JWT_SECRET.")
  return pool
}

export interface CommerceTicket {
  id: string
  chatbotId: string
  customerId: string
  subject: string
  status: "OPEN" | "RESOLVED" | "CLOSED"
  relatedOrderId: string | null
  createdAt: string
  updatedAt: string
}

function mapRow(row: Record<string, unknown>): CommerceTicket {
  return {
    id: row.id as string,
    chatbotId: row.chatbot_id as string,
    customerId: row.customer_id as string,
    subject: row.subject as string,
    status: row.status as CommerceTicket["status"],
    relatedOrderId: (row.related_order_id as string | null) ?? null,
    createdAt: (row.created_at as Date).toISOString(),
    updatedAt: (row.updated_at as Date).toISOString(),
  }
}

export async function createTicket(
  chatbotId: string,
  customerId: string,
  subject: string,
  relatedOrderId?: string | null,
): Promise<CommerceTicket> {
  await authorizeToolCall({ chatbotId, customerId, operation: "create_ticket" })
  const db = requireDbPool()
  const { rows } = await db.query(
    "insert into commerce_tickets (chatbot_id, customer_id, subject, related_order_id) values ($1, $2, $3, $4) returning *",
    [chatbotId, customerId, subject, relatedOrderId ?? null],
  )
  return mapRow(rows[0])
}

export async function getTicketForCustomer(chatbotId: string, customerId: string, ticketId: string): Promise<CommerceTicket> {
  await authorizeToolCall({ chatbotId, customerId, operation: "get_ticket_status", resource: { type: "ticket", id: ticketId } })
  const db = requireDbPool()
  const { rows } = await db.query("select * from commerce_tickets where id = $1 and chatbot_id = $2 and customer_id = $3", [ticketId, chatbotId, customerId])
  if (!rows[0]) throw new AppError(404, "Ticket not found.")
  return mapRow(rows[0])
}
