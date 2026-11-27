
export interface ChatbotActionParameter {
  name: string
  type: "string" | "number" | "boolean"
  description: string
  required: boolean
}

export interface ChatbotAction {
  id: string
  chatbotId: string
  name: string
  description: string
  httpMethod: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"
  urlTemplate: string
  headersTemplate: Record<string, string>
  bodyTemplate: Record<string, unknown> | null
  parameters: ChatbotActionParameter[]
  createdAt: string
  updatedAt: string
}

export function actionRowToAction(row: {
  id: string
  chatbot_id: string
  name: string
  description: string
  http_method: string
  url_template: string
  headers_template: Record<string, string> | null
  body_template: Record<string, unknown> | null
  parameters: ChatbotActionParameter[] | null
  created_at: Date
  updated_at: Date
}): ChatbotAction {
  return {
    id: row.id,
    chatbotId: row.chatbot_id,
    name: row.name,
    description: row.description,
    httpMethod: row.http_method as ChatbotAction["httpMethod"],
    urlTemplate: row.url_template,
    headersTemplate: row.headers_template || {},
    bodyTemplate: row.body_template ?? null,
    parameters: row.parameters || [],
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }
}


// Phase 2 condition: any GET surface must never return a secret header
// value in full — a custom action's headersTemplate is exactly where
// customers put Authorization/API-key headers for the external call.
// Reading a value back as a POST/PUT echo of what the client just typed
// isn't a new exposure, so only the dashboard LIST path uses this; the
// internal answering pipeline (getActionsForAnswering) needs the real
// values to actually call the external API and must never mask.
export function maskSecretValue(value: string): string {
  if (!value) return value
  const last4 = value.slice(-4)
  return value.length <= 4 ? "•".repeat(value.length) : `${"•".repeat(8)}${last4}`
}

export function maskActionForClient(action: ChatbotAction): ChatbotAction {
  const maskedHeaders: Record<string, string> = {}
  for (const [key, value] of Object.entries(action.headersTemplate)) {
    maskedHeaders[key] = maskSecretValue(value)
  }
  return { ...action, headersTemplate: maskedHeaders }
}

// A client that only re-renders a GET's masked value (e.g. editing just the
// name, leaving headers untouched) will echo that mask straight back on the
// next PUT/PATCH. Without this, saving would overwrite the real secret with
// the literal "••••••••1234" string. For each incoming header, if it's
// exactly what masking the CURRENT stored value at that key would produce,
// keep the real stored value instead of the mask the client echoed back.
// Any value that doesn't match — including a genuinely new secret the user
// typed — passes through unchanged.
export function reconcileHeadersTemplate(
  existing: Record<string, string>,
  incoming: Record<string, string>,
): Record<string, string> {
  const resolved: Record<string, string> = {}
  for (const [key, value] of Object.entries(incoming)) {
    const existingValue = existing[key]
    resolved[key] = existingValue !== undefined && value === maskSecretValue(existingValue) ? existingValue : value
  }
  return resolved
}

export interface ActionToolDef {
  name: string
  description: string
  parameters: ChatbotActionParameter[]
}

export interface ToolCallResult {
  content: string
  isError: boolean
}

export type ToolExecutor = (name: string, args: Record<string, unknown>) => Promise<ToolCallResult>
