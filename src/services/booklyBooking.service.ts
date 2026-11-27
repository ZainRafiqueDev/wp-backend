
import { pool } from "../lib/db.js"
import { AppError } from "../lib/errors.js"
import { log } from "../lib/logger.js"
import {
  addNote as addNoteToBooklyAppointment,
  cancelAppointment as cancelBooklyAppointment,
  createAppointment as createBooklyAppointment,
  getAppointment as getBooklyAppointment,
  getAvailableSlots,
  getServiceInfo,
  isBooklyConflict,
  joinWaitlist as joinBooklyWaitlist,
  rescheduleAppointment as rescheduleBooklyAppointment,
} from "../lib/bookly/connector.js"
import type { AddNoteToBooklyAppointmentInput, BooklyAppointment, BooklyServiceInfo } from "../lib/bookly/types.js"
import { getDecryptedBooklyCredentials, getBooklyResourceId } from "./booklyCredentials.service.js"
import { authorizeToolCall, type ToolAuthorizationRequest } from "./toolAuthorization.service.js"

function requireDbPool() {
  if (!pool) throw new AppError(503, "Database is not configured. Set DATABASE_URL and JWT_SECRET.")
  return pool
}

export interface CommitBookingInput {
  chatbotId: string
  customerId: string
  startTime: string
  duration: number
  customer: { name: string; email: string; phone?: string | null }
  notes?: string | null
  attachmentUrl?: string | null
  resourceId?: string
  idempotencyKey: string
  requestId?: string
  graphRunId?: string
  toolCallId?: string
}

export interface LocalBooklyAppointment {
  id: string
  chatbotId: string
  customerId: string
  booklyAppointmentId: string
  booklyResourceId: string
  status: "PENDING" | "CONFIRMED" | "CANCELLED" | "FAILED"
  startTime: string
  createdAt: string
  cancelledAt: string | null
  googleMeetUrl: string | null
  zoomJoinUrl: string | null
}

function mapRow(row: Record<string, unknown>): LocalBooklyAppointment {
  return {
    id: row.id as string,
    chatbotId: row.chatbot_id as string,
    customerId: row.customer_id as string,
    booklyAppointmentId: row.bookly_appointment_id as string,
    booklyResourceId: row.bookly_resource_id as string,
    status: row.status as LocalBooklyAppointment["status"],
    startTime: (row.start_time as Date).toISOString(),
    createdAt: (row.created_at as Date).toISOString(),
    cancelledAt: row.cancelled_at ? (row.cancelled_at as Date).toISOString() : null,
    googleMeetUrl: (row.google_meet_url as string | null) ?? null,
    zoomJoinUrl: (row.zoom_join_url as string | null) ?? null,
  }
}

async function requireCredentials(chatbotId: string) {
  const creds = await getDecryptedBooklyCredentials(chatbotId)
  if (!creds) throw new AppError(503, "This chatbot's Bookly connection is not configured.")
  return creds
}

export async function checkAvailabilityForChatbot(chatbotId: string, customerId: string | null, date: string, duration?: number, resourceId?: string): Promise<string[]> {
  await authorizeToolCall({
    chatbotId,
    customerId,
    operation: "check_availability",
    resource: resourceId ? { type: "bookly_resource", id: resourceId } : undefined,
  })
  const targetResourceId = resourceId ?? (await getBooklyResourceId(chatbotId))
  if (!targetResourceId) throw new AppError(503, "This chatbot's Bookly connection is not configured.")
  const creds = await requireCredentials(chatbotId)
  return getAvailableSlots({ ...creds, resourceId: targetResourceId }, date, duration)
}


export async function commitBooking(input: CommitBookingInput): Promise<LocalBooklyAppointment> {
  const authReq: ToolAuthorizationRequest = {
    chatbotId: input.chatbotId,
    customerId: input.customerId,
    operation: "book_appointment",
    resource: input.resourceId ? { type: "bookly_resource", id: input.resourceId } : undefined,
    requestId: input.requestId,
    graphRunId: input.graphRunId,
    toolCallId: input.toolCallId,
  }
  
  await authorizeToolCall(authReq)

  const db = requireDbPool()
  const resourceId = input.resourceId ?? (await getBooklyResourceId(input.chatbotId))
  if (!resourceId) throw new AppError(503, "This chatbot's Bookly connection is not configured.")
  const placeholderId = `pending:${input.idempotencyKey}`

  const claim = await db.query(
    `insert into chatbot_bookly_appointments (chatbot_id, customer_id, bookly_appointment_id, idempotency_key, bookly_resource_id, start_time, status)
     values ($1, $2, $3, $4, $5, $6, 'PENDING')
     on conflict (chatbot_id, idempotency_key) do nothing
     returning *`,
    [input.chatbotId, input.customerId, placeholderId, input.idempotencyKey, resourceId, input.startTime],
  )

  if (!claim.rows[0]) {
    const { rows: existing } = await db.query(
      "select * from chatbot_bookly_appointments where chatbot_id = $1 and idempotency_key = $2",
      [input.chatbotId, input.idempotencyKey],
    )
    const existingRow = existing[0]
    if (!existingRow || existingRow.status === "PENDING") {
      log().warn({ ...authReq, idempotencyKey: input.idempotencyKey }, "commit_booking: another booking attempt for this idempotency key is already in progress")
      throw new AppError(409, "This booking is already being created. Please wait a moment before retrying.")
    }
    if (existingRow.status === "FAILED") {
      throw new AppError(409, "This booking attempt already failed (the slot was taken). Retry with a new request.")
    }
    log().info({ ...authReq, idempotencyKey: input.idempotencyKey, appointmentId: existingRow.id }, "commit_booking: idempotent replay, Bookly was not called again")
    return mapRow(existingRow)
  }

  // Won the claim — this is the one and only real Bookly call for this
  // idempotency key.
  const creds = await requireCredentials(input.chatbotId)
  let booklyAppointment: BooklyAppointment
  try {
    booklyAppointment = await createBooklyAppointment(creds, {
      resourceId,
      startTime: input.startTime,
      duration: input.duration,
      customer: input.customer,
      notes: input.notes,
      attachmentUrl: input.attachmentUrl,
    })
  } catch (err) {
    await db.query("update chatbot_bookly_appointments set status = 'FAILED' where id = $1", [claim.rows[0].id])
    if (isBooklyConflict(err)) {
      log().warn({ ...authReq, idempotencyKey: input.idempotencyKey }, "commit_booking: Bookly rejected the slot as already taken (exclusion constraint)")
      throw new AppError(409, "That time slot was just taken. Please choose another.")
    }
    log().error({ ...authReq, idempotencyKey: input.idempotencyKey, err: err instanceof Error ? err.message : String(err) }, "commit_booking: Bookly call failed")
    throw new AppError(502, "Could not complete the booking with Bookly. Please try again.")
  }

  const { rows: updated } = await db.query(
    `update chatbot_bookly_appointments
     set bookly_appointment_id = $1, status = 'CONFIRMED', google_meet_url = $2, zoom_join_url = $3
     where id = $4 returning *`,
    [booklyAppointment.id, booklyAppointment.google_meet_url, booklyAppointment.zoom_join_url, claim.rows[0].id],
  )
  log().info(
    { ...authReq, idempotencyKey: input.idempotencyKey, appointmentId: claim.rows[0].id, booklyAppointmentId: booklyAppointment.id },
    "booking committed: real Bookly appointment created, CONFIRMED",
  )
  return mapRow(updated[0])
}

export async function getBookingForCustomer(chatbotId: string, customerId: string, appointmentId: string): Promise<BooklyAppointment> {
  await authorizeToolCall({ chatbotId, customerId, operation: "get_appointment_status", resource: { type: "bookly_appointment", id: appointmentId } })
  const db = requireDbPool()
  const { rows } = await db.query("select bookly_appointment_id from chatbot_bookly_appointments where id = $1", [appointmentId])
  if (!rows[0]) throw new AppError(404, "Appointment not found.")
  const creds = await requireCredentials(chatbotId)
  return getBooklyAppointment(creds, rows[0].bookly_appointment_id)
}

export async function listBookingsForCustomer(chatbotId: string, customerId: string): Promise<LocalBooklyAppointment[]> {
  const db = requireDbPool()
  const { rows } = await db.query(
    `select * from chatbot_bookly_appointments
     where chatbot_id = $1 and customer_id = $2 and status = 'CONFIRMED'
     order by start_time asc`,
    [chatbotId, customerId],
  )
  return rows.map(mapRow)
}

export async function findLatestBookingByEmailForChatbot(chatbotId: string, email: string): Promise<LocalBooklyAppointment | null> {
  const db = requireDbPool()
  const { rows } = await db.query(
    `select cba.* from chatbot_bookly_appointments cba
     join customer_identities ci on ci.id = cba.customer_id
     where cba.chatbot_id = $1 and ci.email = $2 and cba.status = 'CONFIRMED'
     order by cba.start_time desc limit 1`,
    [chatbotId, email.trim().toLowerCase()],
  )
  return rows[0] ? mapRow(rows[0]) : null
}

export async function cancelBookingForCustomer(chatbotId: string, customerId: string, appointmentId: string): Promise<BooklyAppointment> {
  await authorizeToolCall({ chatbotId, customerId, operation: "cancel_appointment", resource: { type: "bookly_appointment", id: appointmentId } })
  const db = requireDbPool()
  const { rows } = await db.query("select bookly_appointment_id from chatbot_bookly_appointments where id = $1", [appointmentId])
  if (!rows[0]) throw new AppError(404, "Appointment not found.")
  const creds = await requireCredentials(chatbotId)
  const cancelled = await cancelBooklyAppointment(creds, rows[0].bookly_appointment_id)
  await db.query("update chatbot_bookly_appointments set status = 'CANCELLED', cancelled_at = now() where id = $1", [appointmentId])
  return cancelled
}

export async function addNoteToBooking(
  chatbotId: string,
  customerId: string,
  appointmentId: string,
  input: AddNoteToBooklyAppointmentInput,
): Promise<BooklyAppointment> {
  if (!input.note && !input.attachmentUrl) {
    throw new AppError(400, "Provide a note and/or an attachment link.")
  }
  await authorizeToolCall({ chatbotId, customerId, operation: "add_note", resource: { type: "bookly_appointment", id: appointmentId } })
  const db = requireDbPool()
  const { rows } = await db.query("select bookly_appointment_id from chatbot_bookly_appointments where id = $1", [appointmentId])
  if (!rows[0]) throw new AppError(404, "Appointment not found.")
  const creds = await requireCredentials(chatbotId)
  return addNoteToBooklyAppointment(creds, rows[0].bookly_appointment_id, input)
}

export async function rescheduleBookingForCustomer(
  chatbotId: string,
  customerId: string,
  appointmentId: string,
  input: { startTime: string; duration: number },
): Promise<BooklyAppointment> {
  await authorizeToolCall({ chatbotId, customerId, operation: "reschedule_appointment", resource: { type: "bookly_appointment", id: appointmentId } })
  const db = requireDbPool()
  const { rows } = await db.query("select bookly_appointment_id from chatbot_bookly_appointments where id = $1", [appointmentId])
  if (!rows[0]) throw new AppError(404, "Appointment not found.")
  const creds = await requireCredentials(chatbotId)
  const rescheduled = await rescheduleBooklyAppointment(creds, rows[0].bookly_appointment_id, input)
  
  await db.query(
    "update chatbot_bookly_appointments set bookly_appointment_id = $1, start_time = $2 where id = $3",
    [rescheduled.id, input.startTime, appointmentId],
  )
  return rescheduled
}

export async function recordReassignment(localAppointmentId: string, newBooklyAppointmentId: string, newResourceId: string, newStartTime: string): Promise<void> {
  const db = requireDbPool()
  await db.query(
    "update chatbot_bookly_appointments set bookly_appointment_id = $1, bookly_resource_id = $2, start_time = $3 where id = $4",
    [newBooklyAppointmentId, newResourceId, newStartTime, localAppointmentId],
  )
}

export async function getServiceInfoForChatbot(chatbotId: string, resourceId?: string): Promise<BooklyServiceInfo> {
  await authorizeToolCall({ chatbotId, customerId: null, operation: "get_service_info", resource: resourceId ? { type: "bookly_resource", id: resourceId } : undefined })
  const targetResourceId = resourceId ?? (await getBooklyResourceId(chatbotId))
  if (!targetResourceId) throw new AppError(503, "This chatbot's Bookly connection is not configured.")
  const creds = await requireCredentials(chatbotId)
  return getServiceInfo({ ...creds, resourceId: targetResourceId })
}


export async function joinWaitlistForChatbot(
  chatbotId: string,
  customerId: string,
  input: { customerName: string; customerEmail: string; requestedDate: string; resourceId?: string },
): Promise<{ id: string }> {
  await authorizeToolCall({ chatbotId, customerId, operation: "join_waitlist", resource: input.resourceId ? { type: "bookly_resource", id: input.resourceId } : undefined })
  const targetResourceId = input.resourceId ?? (await getBooklyResourceId(chatbotId))
  if (!targetResourceId) throw new AppError(503, "This chatbot's Bookly connection is not configured.")
  const creds = await requireCredentials(chatbotId)
  return joinBooklyWaitlist(creds, {
    resourceId: targetResourceId,
    customerName: input.customerName,
    customerEmail: input.customerEmail,
    requestedDate: input.requestedDate,
  })
}
