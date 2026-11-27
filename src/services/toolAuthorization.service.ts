
import { pool } from "../lib/db.js"
import { AppError } from "../lib/errors.js"
import { log } from "../lib/logger.js"
import { customerBelongsToChatbot, getVerificationLevel, VERIFICATION_LEVEL_RANK, type VerificationLevel } from "./customerIdentity.service.js"
import { getCommerceOrder } from "./orderState.service.js"
import { hasWooCommerceConnected, requireFullCustomPlan } from "./commerceCredentials.service.js"
import { getBooklyResourceId, hasBooklyConnected, isBooklyResourceConfigured } from "./booklyCredentials.service.js"

export type ToolOperation =
  | "lookup_product"
  | "check_stock"
  | "create_order"
  | "get_order_status"
  | "create_ticket"
  | "get_ticket_status"
  | "check_availability"
  | "book_appointment"
  | "get_appointment_status"
  | "cancel_appointment"
  | "reschedule_appointment"
  | "add_note"
  | "get_service_info"
  | "join_waitlist"
  | "admin_create_resource"
  | "admin_set_availability_rule"
  | "admin_add_exception"
  | "admin_reassign_appointment"

const BOOKLY_OPERATIONS = new Set<ToolOperation>([
  "check_availability",
  "book_appointment",
  "get_appointment_status",
  "cancel_appointment",
  "reschedule_appointment",
  "add_note",
  "get_service_info",
  "join_waitlist",
])

const BOOKLY_ADMIN_OPERATIONS = new Set<ToolOperation>([
  "admin_create_resource",
  "admin_set_availability_rule",
  "admin_add_exception",
  "admin_reassign_appointment",
])

function isBooklyOperation(operation: ToolOperation): boolean {
  return BOOKLY_OPERATIONS.has(operation)
}

function isBooklyAdminOperation(operation: ToolOperation): boolean {
  return BOOKLY_ADMIN_OPERATIONS.has(operation)
}


const REQUIRED_VERIFICATION: Record<ToolOperation, VerificationLevel | null> = {
  lookup_product: null,
  check_stock: null,
  create_order: "UNVERIFIED", // a resolved (even freshly-created) identity, not a prior verified one
  get_order_status: "ORDER_VERIFIED",
  create_ticket: "UNVERIFIED",
  get_ticket_status: "ORDER_VERIFIED",
  check_availability: null,
  book_appointment: "UNVERIFIED",
  // CS-04: existing-booking reads/writes need a customer who has proved the
  // email at least once. This is a floor, not the gate: the chat graphs also
  // require a fresh per-session OTP/token proof (the stored level never expires).
  get_appointment_status: "EMAIL_VERIFIED",
  cancel_appointment: "EMAIL_VERIFIED",
  reschedule_appointment: "EMAIL_VERIFIED",
  add_note: "EMAIL_VERIFIED",
  get_service_info: null, 
  join_waitlist: "UNVERIFIED", 
  admin_create_resource: null,
  admin_set_availability_rule: null,
  admin_add_exception: null,
  admin_reassign_appointment: null,
}

export interface ToolAuthorizationRequest {
  chatbotId: string
  customerId: string | null
  operation: ToolOperation
  resource?: { type: "order" | "ticket" | "bookly_appointment" | "bookly_resource"; id: string }
  adminId?: string
  requestId?: string
  graphRunId?: string
  toolCallId?: string
}


async function ticketBelongsToCustomer(ticketId: string, chatbotId: string, customerId: string | null): Promise<boolean> {
  if (!pool || !customerId) return false
  const { rows } = await pool.query("select 1 from commerce_tickets where id = $1 and chatbot_id = $2 and customer_id = $3", [ticketId, chatbotId, customerId])
  return rows.length > 0
}


async function booklyAppointmentBelongsToCustomer(appointmentId: string, chatbotId: string, customerId: string | null): Promise<boolean> {
  if (!pool || !customerId) return false
  const { rows } = await pool.query(
    "select 1 from chatbot_bookly_appointments where id = $1 and chatbot_id = $2 and customer_id = $3",
    [appointmentId, chatbotId, customerId],
  )
  return rows.length > 0
}

export async function authorizeToolCall(req: ToolAuthorizationRequest): Promise<void> {
  const logCtx = { chatbotId: req.chatbotId, customerId: req.customerId, operation: req.operation, requestId: req.requestId, graphRunId: req.graphRunId, toolCallId: req.toolCallId }


  if (isBooklyAdminOperation(req.operation)) {
    if (!req.adminId) {
      log().error(logCtx, "tool authorization denied: admin operation attempted with no verified admin identity")
      throw new AppError(401, "This action requires a verified Bookly admin session.")
    }
    const connected = await hasBooklyConnected(req.chatbotId)
    if (!connected) {
      log().warn(logCtx, "tool authorization denied: chatbot has no connected Bookly resource")
      throw new AppError(403, "This chatbot has no connected Bookly resource.")
    }
    await requireFullCustomPlan(req.chatbotId)
    log().info(logCtx, "admin tool call authorized")
    return
  }


  if (isBooklyOperation(req.operation)) {
    const connected = await hasBooklyConnected(req.chatbotId)
    if (!connected) {
      log().warn(logCtx, "tool authorization denied: chatbot has no connected Bookly resource")
      throw new AppError(403, "This chatbot has no connected Bookly resource.")
    }
  } else {
    const connected = await hasWooCommerceConnected(req.chatbotId)
    if (!connected) {
      log().warn(logCtx, "tool authorization denied: chatbot has no connected WooCommerce store")
      throw new AppError(403, "This chatbot has no connected WooCommerce store.")
    }
  }
  await requireFullCustomPlan(req.chatbotId)


  if (req.customerId) {
    const belongs = await customerBelongsToChatbot(req.customerId, req.chatbotId)
    if (!belongs) {
      log().error(logCtx, "tool authorization denied: customer_id does not belong to this chatbot (cross-tenant attempt)")
      throw new AppError(403, "Customer identity does not belong to this chatbot.")
    }
  }

  const required = REQUIRED_VERIFICATION[req.operation]
  if (required) {
    if (!req.customerId) {
      log().warn(logCtx, "tool authorization denied: operation requires a resolved customer identity")
      throw new AppError(403, `Operation "${req.operation}" requires a resolved customer identity.`)
    }
    const level = await getVerificationLevel(req.customerId)
    if (VERIFICATION_LEVEL_RANK[level] < VERIFICATION_LEVEL_RANK[required]) {
      log().warn({ ...logCtx, requiredLevel: required, actualLevel: level }, "tool authorization denied: insufficient verification level")
      throw new AppError(403, `Operation "${req.operation}" requires verification level ${required}, customer has ${level}.`)
    }
  }

 
  if (req.resource?.type === "order") {
    const order = await getCommerceOrder(req.resource.id)
    if (!order || order.chatbotId !== req.chatbotId || order.customerId !== req.customerId) {
      log().error(logCtx, "tool authorization denied: order does not belong to this customer/chatbot")
      throw new AppError(404, "Order not found.")
    }
  }
  if (req.resource?.type === "ticket") {
    const owns = await ticketBelongsToCustomer(req.resource.id, req.chatbotId, req.customerId)
    if (!owns) {
      log().error(logCtx, "tool authorization denied: ticket does not belong to this customer/chatbot")
      throw new AppError(404, "Ticket not found.")
    }
  }
  if (req.resource?.type === "bookly_appointment") {
    const owns = await booklyAppointmentBelongsToCustomer(req.resource.id, req.chatbotId, req.customerId)
    if (!owns) {
      log().error(logCtx, "tool authorization denied: appointment does not belong to this customer/chatbot")
      throw new AppError(404, "Appointment not found.")
    }
  }

  if (req.resource?.type === "bookly_resource") {
    const configured = await isBooklyResourceConfigured(req.chatbotId, req.resource.id)
    if (!configured) {
      log().error(logCtx, "tool authorization denied: resource is not configured for this chatbot")
      throw new AppError(404, "Resource not found.")
    }
  }


  if ((req.operation === "book_appointment" || req.operation === "check_availability") && req.resource?.type !== "bookly_resource") {
    const resourceId = await getBooklyResourceId(req.chatbotId)
    if (!resourceId) {
      log().error(logCtx, "tool authorization denied: Bookly connection has no resolvable resource id")
      throw new AppError(403, "This chatbot's Bookly connection is not fully configured.")
    }
  }

  log().info(logCtx, "tool call authorized")
}
