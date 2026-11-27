
import { AppError } from "../lib/errors.js"
import { log } from "../lib/logger.js"
import {
  BooklyAdminApiError,
  createAvailabilityRule as createAvailabilityRuleRest,
  createException as createExceptionRest,
  createResource as createResourceRest,
  getAppointment as getAppointmentRest,
  reassignAppointment as reassignAppointmentRest,
  type BooklyResource,
  type CreateAvailabilityRuleInput,
  type CreateExceptionInput,
  type CreateResourceInput,
} from "../lib/bookly/adminConnector.js"
import { getBooklyBaseUrl, isBooklyResourceConfigured } from "./booklyCredentials.service.js"
import { authorizeToolCall } from "./toolAuthorization.service.js"
import { recordAdminAction } from "./booklyAdminAudit.service.js"
import type { VerifiedBooklyAdmin } from "./booklyAdminAuth.service.js"
import { findLatestBookingByEmailForChatbot, recordReassignment } from "./booklyBooking.service.js"

export interface AdminToolContext {
  chatbotId: string
  admin: VerifiedBooklyAdmin
  token: string
  conversationId: string
  requestId?: string
}

async function requireBaseUrl(chatbotId: string): Promise<string> {
  const baseUrl = await getBooklyBaseUrl(chatbotId)
  if (!baseUrl) throw new AppError(503, "This chatbot's Bookly connection is not configured.")
  return baseUrl
}

function mapRestError(err: unknown): Error {
  if (err instanceof BooklyAdminApiError) return new AppError(err.status >= 500 ? 502 : err.status, err.message)
  return err instanceof Error ? err : new Error(String(err))
}

export async function createResourceAsAdmin(ctx: AdminToolContext, input: CreateResourceInput): Promise<BooklyResource> {
  await authorizeToolCall({ chatbotId: ctx.chatbotId, customerId: null, operation: "admin_create_resource", adminId: ctx.admin.id, requestId: ctx.requestId })

  const baseUrl = await requireBaseUrl(ctx.chatbotId)
  try {
    const resource = await createResourceRest(baseUrl, ctx.token, input)
    await recordAdminAction({
      chatbotId: ctx.chatbotId,
      adminId: ctx.admin.id,
      adminEmail: ctx.admin.email,
      conversationId: ctx.conversationId,
      requestId: ctx.requestId,
      action: "admin_create_resource",
      targetResource: resource.id,
      beforeState: null,
      afterState: { name: resource.name, timezone: resource.timezone, slot_duration_minutes: resource.slot_duration_minutes },
      success: true,
    })
    log().info({ chatbotId: ctx.chatbotId, adminId: ctx.admin.id, resourceId: resource.id }, "admin_create_resource: created")
    return resource
  } catch (err) {
    await recordAdminAction({
      chatbotId: ctx.chatbotId,
      adminId: ctx.admin.id,
      adminEmail: ctx.admin.email,
      conversationId: ctx.conversationId,
      requestId: ctx.requestId,
      action: "admin_create_resource",
      targetResource: null,
      beforeState: null,
      afterState: null,
      success: false,
      errorMessage: err instanceof Error ? err.message : String(err),
    })
    throw mapRestError(err)
  }
}

export async function setAvailabilityRuleAsAdmin(ctx: AdminToolContext, resourceId: string, input: CreateAvailabilityRuleInput): Promise<unknown> {
  await authorizeToolCall({ chatbotId: ctx.chatbotId, customerId: null, operation: "admin_set_availability_rule", adminId: ctx.admin.id, requestId: ctx.requestId })

  const baseUrl = await requireBaseUrl(ctx.chatbotId)
  try {
    const rule = await createAvailabilityRuleRest(baseUrl, ctx.token, resourceId, input)
    await recordAdminAction({
      chatbotId: ctx.chatbotId,
      adminId: ctx.admin.id,
      adminEmail: ctx.admin.email,
      conversationId: ctx.conversationId,
      requestId: ctx.requestId,
      action: "admin_set_availability_rule",
      targetResource: resourceId,
      beforeState: null,
      afterState: input,
      success: true,
    })
    log().info({ chatbotId: ctx.chatbotId, adminId: ctx.admin.id, resourceId }, "admin_set_availability_rule: created")
    return rule
  } catch (err) {
    await recordAdminAction({
      chatbotId: ctx.chatbotId,
      adminId: ctx.admin.id,
      adminEmail: ctx.admin.email,
      conversationId: ctx.conversationId,
      requestId: ctx.requestId,
      action: "admin_set_availability_rule",
      targetResource: resourceId,
      beforeState: null,
      afterState: null,
      success: false,
      errorMessage: err instanceof Error ? err.message : String(err),
    })
    throw mapRestError(err)
  }
}



export async function reassignAppointmentAsAdmin(
  ctx: AdminToolContext,
  customerEmail: string,
  newResourceId: string,
): Promise<{ oldResourceId: string; newResourceId: string; startTime: string }> {
  await authorizeToolCall({ chatbotId: ctx.chatbotId, customerId: null, operation: "admin_reassign_appointment", adminId: ctx.admin.id, requestId: ctx.requestId })

  const configured = await isBooklyResourceConfigured(ctx.chatbotId, newResourceId)
  if (!configured) throw new AppError(404, "That resource is not configured for this chatbot.")

  const booking = await findLatestBookingByEmailForChatbot(ctx.chatbotId, customerEmail)
  if (!booking) throw new AppError(404, `No upcoming appointment found for ${customerEmail}.`)
  if (booking.booklyResourceId === newResourceId) {
    throw new AppError(400, "That appointment is already assigned to that resource.")
  }

  const baseUrl = await requireBaseUrl(ctx.chatbotId)
  const oldResourceId = booking.booklyResourceId
  try {
    
    const current = await getAppointmentRest(baseUrl, ctx.token, booking.booklyAppointmentId)
    const durationMinutes = Math.round((new Date(current.end_time).getTime() - new Date(current.start_time).getTime()) / 60000)
    const reassigned = await reassignAppointmentRest(baseUrl, ctx.token, booking.booklyAppointmentId, {
      startTime: booking.startTime,
      duration: durationMinutes,
      resourceId: newResourceId,
    })
    await recordReassignment(booking.id, reassigned.id, newResourceId, reassigned.start_time)
    await recordAdminAction({
      chatbotId: ctx.chatbotId,
      adminId: ctx.admin.id,
      adminEmail: ctx.admin.email,
      conversationId: ctx.conversationId,
      requestId: ctx.requestId,
      action: "admin_reassign_appointment",
      targetResource: newResourceId,
      beforeState: { resourceId: oldResourceId, customerEmail },
      afterState: { resourceId: newResourceId, customerEmail },
      success: true,
    })
    log().info({ chatbotId: ctx.chatbotId, adminId: ctx.admin.id, oldResourceId, newResourceId }, "admin_reassign_appointment: reassigned")
    return { oldResourceId, newResourceId, startTime: reassigned.start_time }
  } catch (err) {
    await recordAdminAction({
      chatbotId: ctx.chatbotId,
      adminId: ctx.admin.id,
      adminEmail: ctx.admin.email,
      conversationId: ctx.conversationId,
      requestId: ctx.requestId,
      action: "admin_reassign_appointment",
      targetResource: newResourceId,
      beforeState: { resourceId: oldResourceId, customerEmail },
      afterState: null,
      success: false,
      errorMessage: err instanceof Error ? err.message : String(err),
    })
    throw mapRestError(err)
  }
}

export async function addExceptionAsAdmin(ctx: AdminToolContext, resourceId: string, input: CreateExceptionInput): Promise<unknown> {
  await authorizeToolCall({ chatbotId: ctx.chatbotId, customerId: null, operation: "admin_add_exception", adminId: ctx.admin.id, requestId: ctx.requestId })

  const baseUrl = await requireBaseUrl(ctx.chatbotId)
  try {
    const exception = await createExceptionRest(baseUrl, ctx.token, resourceId, input)
    await recordAdminAction({
      chatbotId: ctx.chatbotId,
      adminId: ctx.admin.id,
      adminEmail: ctx.admin.email,
      conversationId: ctx.conversationId,
      requestId: ctx.requestId,
      action: "admin_add_exception",
      targetResource: resourceId,
      beforeState: null,
      afterState: input,
      success: true,
    })
    log().info({ chatbotId: ctx.chatbotId, adminId: ctx.admin.id, resourceId }, "admin_add_exception: created")
    return exception
  } catch (err) {
    await recordAdminAction({
      chatbotId: ctx.chatbotId,
      adminId: ctx.admin.id,
      adminEmail: ctx.admin.email,
      conversationId: ctx.conversationId,
      requestId: ctx.requestId,
      action: "admin_add_exception",
      targetResource: resourceId,
      beforeState: null,
      afterState: null,
      success: false,
      errorMessage: err instanceof Error ? err.message : String(err),
    })
    throw mapRestError(err)
  }
}
