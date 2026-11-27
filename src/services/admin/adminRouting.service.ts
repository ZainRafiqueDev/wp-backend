import { listRoutingEvents, type RoutingReason } from "../routingEvents.service.js"
import { requireAdminUserId } from "./adminAuth.service.js"

export interface AdminRoutingEvent {
  id: string
  requestId: string
  chatbotId: string
  chatbotName: string
  conversationId: string | null
  previousModel: string | null
  selectedModel: string
  reason: RoutingReason
  providerErrorClass: string | null
  createdAt: string
}

export async function getAdminRoutingActivity(
  accessToken: string,
  filters: { chatbotId?: string; reason?: RoutingReason; limit?: number },
): Promise<AdminRoutingEvent[]> {
  requireAdminUserId(accessToken)
  const rows = await listRoutingEvents(filters)
  return rows.map((row) => ({
    id: row.id,
    requestId: row.request_id,
    chatbotId: row.chatbot_id,
    chatbotName: row.chatbot_name,
    conversationId: row.conversation_id,
    previousModel: row.previous_model,
    selectedModel: row.selected_model,
    reason: row.reason,
    providerErrorClass: row.provider_error_class,
    createdAt: row.created_at,
  }))
}
