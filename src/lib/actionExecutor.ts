import type { ChatbotAction, ChatbotActionParameter, ToolCallResult } from "./actions.js"
import { assertSafeUrl } from "./crawler/ssrf.js"
import { outboundFetch } from "./outboundFetch.js"
import { log } from "./logger.js"


const ACTION_TIMEOUT_MS = 4000
const MAX_RESPONSE_CHARS = 4000
const UNAVAILABLE_MESSAGE = "This action is currently unavailable."
const TEMPLATE_PATTERN = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g

function matchesType(value: unknown, type: ChatbotActionParameter["type"]): boolean {
  if (type === "string") return typeof value === "string"
  if (type === "number") return typeof value === "number" && Number.isFinite(value)
  return typeof value === "boolean"
}


export function validateActionParams(
  action: ChatbotAction,
  args: Record<string, unknown>,
): { ok: true; values: Record<string, unknown> } | { ok: false; error: string } {
  const values: Record<string, unknown> = {}
  for (const param of action.parameters) {
    const value = args[param.name]
    if (value === undefined || value === null) {
      if (param.required) return { ok: false, error: `Missing required parameter "${param.name}".` }
      continue
    }
    if (!matchesType(value, param.type)) {
      return { ok: false, error: `Parameter "${param.name}" must be of type ${param.type}.` }
    }
    values[param.name] = value
  }
  return { ok: true, values }
}

function fillTemplate(template: string, values: Record<string, unknown>): string {
  return template.replace(TEMPLATE_PATTERN, (match, key: string) =>
    values[key] === undefined ? match : String(values[key]),
  )
}

// Audit 2026-11-27: parameter values come from the model, and a widget
// visitor can steer the model with prompt injection. In the URL each value is
// percent-encoded, so it can't add path segments, query parameters, a
// fragment or userinfo ("@other-host"). A bare "." or ".." would still be
// read as a dot segment by the URL parser (even percent-encoded), so it is
// refused.
function fillUrlTemplate(template: string, values: Record<string, unknown>): string {
  return template.replace(TEMPLATE_PATTERN, (match, key: string) => {
    if (values[key] === undefined) return match
    const raw = String(values[key])
    if (raw === "." || raw === "..") throw new Error("dot-segment parameter value")
    return encodeURIComponent(raw)
  })
}

// The template's scheme://host[:port] when it has no placeholder in it, else
// null. The chatbot's saved API key is only sent to that fixed origin, never
// to a host the model filled in.
function staticTemplateOrigin(template: string): string | null {
  const match = /^(https?:\/\/[^/?#]*)/i.exec(template)
  if (!match || match[1].includes("{{")) return null
  try {
    return new URL(match[1]).origin
  } catch {
    return null
  }
}

function fillHeaders(headers: Record<string, string>, values: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key, fillTemplate(value, values)]))
}

function fillBody(body: unknown, values: Record<string, unknown>): unknown {
  if (typeof body === "string") return fillTemplate(body, values)
  if (Array.isArray(body)) return body.map((item) => fillBody(item, values))
  if (body && typeof body === "object") {
    return Object.fromEntries(
      Object.entries(body as Record<string, unknown>).map(([key, value]) => [key, fillBody(value, values)]),
    )
  }
  return body
}


export async function executeAction(
  action: ChatbotAction,
  values: Record<string, unknown>,
  apiKey: string | null,
): Promise<ToolCallResult> {
  let url: URL
  try {
    url = new URL(fillUrlTemplate(action.urlTemplate, values))
  } catch {
    log().warn({ action: action.name }, "action has an invalid url_template")
    return { content: UNAVAILABLE_MESSAGE, isError: true }
  }

  try {
    await assertSafeUrl(url)
  } catch (err) {
    log().warn(
      { action: action.name, err: err instanceof Error ? err.message : String(err) },
      "action call blocked by SSRF check",
    )
    return { content: UNAVAILABLE_MESSAGE, isError: true }
  }

  const headers: Record<string, string> = {
    Accept: "application/json",
    ...fillHeaders(action.headersTemplate, values),
  }
  
  const keyOrigin = staticTemplateOrigin(action.urlTemplate)
  if (apiKey && keyOrigin === url.origin && !Object.keys(headers).some((h) => h.toLowerCase() === "authorization")) {
    headers.Authorization = `Bearer ${apiKey}`
  }

  const includesBody = action.httpMethod !== "GET" && action.httpMethod !== "DELETE"
  const body = includesBody && action.bodyTemplate ? JSON.stringify(fillBody(action.bodyTemplate, values)) : undefined
  if (body !== undefined) headers["Content-Type"] = "application/json"

  const startedAt = Date.now()
  try {
    const res = await outboundFetch(url, {
      method: action.httpMethod,
      headers,
      body,
      signal: AbortSignal.timeout(ACTION_TIMEOUT_MS),
    })
    const latencyMs = Date.now() - startedAt
    const text = await res.text().catch(() => "")

    if (!res.ok) {
      log().warn({ action: action.name, status: res.status, latencyMs }, "action call returned an error status")
      return { content: UNAVAILABLE_MESSAGE, isError: true }
    }

    log().info({ action: action.name, status: res.status, latencyMs }, "action call succeeded")
    return { content: text.slice(0, MAX_RESPONSE_CHARS) || "{}", isError: false }
  } catch (err) {
    log().warn(
      { action: action.name, latencyMs: Date.now() - startedAt, err: err instanceof Error ? err.message : String(err) },
      "action call failed or timed out",
    )
    return { content: UNAVAILABLE_MESSAGE, isError: true }
  }
}
