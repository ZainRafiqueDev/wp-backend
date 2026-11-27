import { pool } from "../lib/db.js"
import { log } from "../lib/logger.js"

// Persists WHY a model was chosen/switched, so QUOTA_SWITCH and
// PROVIDER_FAILURE are distinguishable after the fact — previously this
// only ever existed as an ad-hoc log field (modelSelection.service.ts),
// never queryable. Powers the admin "Routing Activity" panel
// (admin.service.ts's getRoutingActivity). Fire-and-forget: a routing
// event is telemetry, never allowed to block or fail the actual request.
export type RoutingReason =
  | "INITIAL_SELECTION"
  | "USER_SELECTED"
  | "QUOTA_SWITCH"
  | "COST_SWITCH"
  | "PROVIDER_FAILURE"
  | "ADMIN_OVERRIDE"
  | "FALLBACK_DENIED"
  | "CIRCUIT_OPEN"

export interface RoutingEventInput {
  requestId: string
  chatbotId: string
  conversationId?: string | null
  previousModel?: string | null
  selectedModel: string
  reason: RoutingReason
  providerErrorClass?: string | null
}

export async function recordRoutingEvent(input: RoutingEventInput): Promise<void> {
  if (!pool) return
  try {
    await pool.query(
      `insert into routing_events (request_id, chatbot_id, conversation_id, previous_model, selected_model, reason, provider_error_class)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [
        input.requestId,
        input.chatbotId,
        input.conversationId ?? null,
        input.previousModel ?? null,
        input.selectedModel,
        input.reason,
        input.providerErrorClass ?? null,
      ],
    )
  } catch (err) {
    log().warn({ ...input, err: err instanceof Error ? err.message : String(err) }, "failed to record routing event")
  }
}

export interface RoutingEventRow {
  id: string
  request_id: string
  chatbot_id: string
  chatbot_name: string
  conversation_id: string | null
  previous_model: string | null
  selected_model: string
  reason: RoutingReason
  provider_error_class: string | null
  created_at: string
}

// Powers the admin "Routing Activity" panel (admin.service.ts).
export async function listRoutingEvents(filters: { chatbotId?: string; reason?: RoutingReason; limit?: number }): Promise<RoutingEventRow[]> {
  if (!pool) return []
  const conditions: string[] = []
  const params: unknown[] = []
  if (filters.chatbotId) {
    params.push(filters.chatbotId)
    conditions.push(`re.chatbot_id = $${params.length}`)
  }
  if (filters.reason) {
    params.push(filters.reason)
    conditions.push(`re.reason = $${params.length}`)
  }
  const where = conditions.length > 0 ? `where ${conditions.join(" and ")}` : ""
  params.push(Math.min(filters.limit ?? 100, 500))

  const { rows } = await pool.query<RoutingEventRow>(
    `select re.id, re.request_id, re.chatbot_id, c.name as chatbot_name, re.conversation_id,
            re.previous_model, re.selected_model, re.reason, re.provider_error_class, re.created_at
     from routing_events re
     join chatbots c on c.id = re.chatbot_id
     ${where}
     order by re.created_at desc
     limit $${params.length}`,
    params,
  )
  return rows
}
