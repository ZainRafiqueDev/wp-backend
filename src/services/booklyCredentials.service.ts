
import { hasIntegrationEncryption } from "../env.js"
import { verifyAccessToken } from "../lib/auth.js"
import { requireOwnedChatbotId } from "../lib/chatbotOwnership.js"
import { decryptSecret, encryptSecret } from "../lib/crypto.js"
import { pool } from "../lib/db.js"
import { AppError } from "../lib/errors.js"
import { BooklyApiError, getAvailableSlots, getMeetingHistoryReportPdf } from "../lib/bookly/connector.js"
import type { BooklyCredentials } from "../lib/bookly/types.js"
import { requireFullCustomPlan } from "./commerceCredentials.service.js"
import { resolveTenantContext } from "../lib/tenancy.js"

function requireDbPool() {
  if (!pool) throw new AppError(503, "Database is not configured. Set DATABASE_URL and JWT_SECRET.")
  return pool
}

function requireUserId(accessToken: string): string {
  const userId = verifyAccessToken(accessToken)
  if (!userId) throw new AppError(401, "Please sign in again.")
  return userId
}

function requireEncryption() {
  if (!hasIntegrationEncryption) {
    throw new AppError(503, "The Bookly scheduling integration is not configured. Set INTEGRATION_ENCRYPTION_KEY.")
  }
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "")
}

export interface BooklyConnectionStatus {
  connected: boolean
  baseUrl: string | null
  resourceId: string | null
  resourceLabel: string | null
  createdAt: string | null
}

export interface ConnectBooklyInput {
  baseUrl: string
  resourceId: string
  resourceLabel: string
  apiKey: string
}

export async function getBooklyConnectionStatus(accessToken: string, chatbotId: string): Promise<BooklyConnectionStatus> {
  const db = requireDbPool()
  const actorUserId = requireUserId(accessToken)
  const { tenantUserId } = await resolveTenantContext(actorUserId, "viewer")
  const ownedId = await requireOwnedChatbotId(tenantUserId, chatbotId)

  const { rows } = await db.query<{ base_url: string; resource_id: string; resource_label: string; created_at: Date }>(
    "select base_url, resource_id, resource_label, created_at from chatbot_bookly_credentials where chatbot_id = $1",
    [ownedId],
  )
  const row = rows[0]
  return {
    connected: Boolean(row),
    baseUrl: row?.base_url ?? null,
    resourceId: row?.resource_id ?? null,
    resourceLabel: row?.resource_label ?? null,
    createdAt: row ? row.created_at.toISOString() : null,
  }
}


export async function connectBookly(accessToken: string, chatbotId: string, input: ConnectBooklyInput): Promise<BooklyConnectionStatus> {
  requireEncryption()
  const db = requireDbPool()
  const actorUserId = requireUserId(accessToken)
  const { tenantUserId } = await resolveTenantContext(actorUserId, "admin")
  const ownedId = await requireOwnedChatbotId(tenantUserId, chatbotId)
  await requireFullCustomPlan(ownedId)

  const baseUrl = normalizeBaseUrl(input.baseUrl)
  let parsed: URL
  try {
    parsed = new URL(baseUrl)
  } catch {
    throw new AppError(400, "Enter a valid Bookly server URL, like https://booking.yourbusiness.com.")
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new AppError(400, "Enter a valid http or https Bookly server URL.")
  }
  if (!input.resourceId.trim()) {
    throw new AppError(400, "A Bookly resource id is required.")
  }
  if (!input.apiKey.trim()) {
    throw new AppError(400, "A Bookly API key is required.")
  }

  const creds: BooklyCredentials = { baseUrl, apiKey: input.apiKey.trim(), resourceId: input.resourceId.trim() }
  try {
    await getAvailableSlots(creds, new Date().toISOString().slice(0, 10))
  } catch (err) {
    if (err instanceof BooklyApiError && (err.status === 401 || err.status === 403)) {
      throw new AppError(400, "This Bookly API key is invalid, revoked, or not scoped to that resource.")
    }
    if (err instanceof BooklyApiError && err.status === 404) {
      throw new AppError(400, "No Bookly resource was found with that id on that server.")
    }
    throw new AppError(400, "Could not verify this Bookly connection. Check the server URL, resource id, and API key.")
  }

  const { rows } = await db.query<{ created_at: Date }>(
    `insert into chatbot_bookly_credentials (chatbot_id, base_url, resource_id, resource_label, api_key_encrypted)
     values ($1, $2, $3, $4, $5)
     on conflict (chatbot_id) do nothing
     returning created_at`,
    [ownedId, baseUrl, input.resourceId.trim(), input.resourceLabel.trim() || input.resourceId.trim(), encryptSecret(input.apiKey.trim())],
  )
  if (!rows[0]) {
    throw new AppError(409, "This chatbot already has a connected Bookly resource. Disconnect it first to reconnect.")
  }

  return {
    connected: true,
    baseUrl,
    resourceId: input.resourceId.trim(),
    resourceLabel: input.resourceLabel.trim() || input.resourceId.trim(),
    createdAt: rows[0].created_at.toISOString(),
  }
}

export async function disconnectBookly(accessToken: string, chatbotId: string): Promise<void> {
  const db = requireDbPool()
  const actorUserId = requireUserId(accessToken)
  const { tenantUserId } = await resolveTenantContext(actorUserId, "admin")
  const ownedId = await requireOwnedChatbotId(tenantUserId, chatbotId)
  await db.query("delete from chatbot_bookly_credentials where chatbot_id = $1", [ownedId])
}


export async function getDecryptedBooklyCredentials(chatbotId: string): Promise<BooklyCredentials | null> {
  if (!hasIntegrationEncryption) return null
  const db = requireDbPool()
  const { rows } = await db.query<{ base_url: string; resource_id: string; api_key_encrypted: string }>(
    "select base_url, resource_id, api_key_encrypted from chatbot_bookly_credentials where chatbot_id = $1",
    [chatbotId],
  )
  const row = rows[0]
  if (!row) return null
  return { baseUrl: row.base_url, resourceId: row.resource_id, apiKey: decryptSecret(row.api_key_encrypted) }
}


export async function hasBooklyConnected(chatbotId: string): Promise<boolean> {
  const db = requireDbPool()
  const { rows } = await db.query("select 1 from chatbot_bookly_credentials where chatbot_id = $1", [chatbotId])
  return rows.length > 0
}


export async function getBooklyResourceId(chatbotId: string): Promise<string | null> {
  const db = requireDbPool()
  const { rows } = await db.query<{ resource_id: string }>("select resource_id from chatbot_bookly_credentials where chatbot_id = $1", [chatbotId])
  return rows[0]?.resource_id ?? null
}


export async function getBooklyBaseUrl(chatbotId: string): Promise<string | null> {
  const db = requireDbPool()
  const { rows } = await db.query<{ base_url: string }>("select base_url from chatbot_bookly_credentials where chatbot_id = $1", [chatbotId])
  return rows[0]?.base_url ?? null
}

export interface BooklyResourceOption {
  resourceId: string
  resourceLabel: string
}


export async function listBooklyResourceOptions(chatbotId: string): Promise<BooklyResourceOption[]> {
  const db = requireDbPool()
  const { rows: primary } = await db.query<{ resource_id: string; resource_label: string }>(
    "select resource_id, resource_label from chatbot_bookly_credentials where chatbot_id = $1",
    [chatbotId],
  )
  if (!primary[0]) return []
  const { rows: additional } = await db.query<{ resource_id: string; resource_label: string }>(
    "select resource_id, resource_label from chatbot_bookly_additional_resources where chatbot_id = $1 order by created_at asc",
    [chatbotId],
  )
  return [
    { resourceId: primary[0].resource_id, resourceLabel: primary[0].resource_label },
    ...additional.map((r) => ({ resourceId: r.resource_id, resourceLabel: r.resource_label })),
  ]
}


export async function isBooklyResourceConfigured(chatbotId: string, resourceId: string): Promise<boolean> {
  const options = await listBooklyResourceOptions(chatbotId)
  return options.some((o) => o.resourceId === resourceId)
}


export async function addBooklyResource(
  accessToken: string,
  chatbotId: string,
  input: { resourceId: string; resourceLabel: string },
): Promise<BooklyResourceOption[]> {
  const db = requireDbPool()
  const actorUserId = requireUserId(accessToken)
  const { tenantUserId } = await resolveTenantContext(actorUserId, "admin")
  const ownedId = await requireOwnedChatbotId(tenantUserId, chatbotId)
  await requireFullCustomPlan(ownedId)

  const creds = await getDecryptedBooklyCredentials(ownedId)
  if (!creds) throw new AppError(503, "Connect a Bookly resource first before adding another.")
  if (!input.resourceId.trim()) throw new AppError(400, "A Bookly resource id is required.")

  try {
    await getAvailableSlots({ ...creds, resourceId: input.resourceId.trim() }, new Date().toISOString().slice(0, 10))
  } catch (err) {
    if (err instanceof BooklyApiError && err.status === 404) {
      throw new AppError(400, "No Bookly resource was found with that id on that server.")
    }
    if (err instanceof BooklyApiError && (err.status === 401 || err.status === 403)) {
      throw new AppError(400, "This chatbot's Bookly API key is not scoped to that resource.")
    }
    throw new AppError(400, "Could not verify that resource. Check the resource id.")
  }

  await db.query(
    `insert into chatbot_bookly_additional_resources (chatbot_id, resource_id, resource_label)
     values ($1, $2, $3)
     on conflict (chatbot_id, resource_id) do update set resource_label = excluded.resource_label`,
    [ownedId, input.resourceId.trim(), input.resourceLabel.trim() || input.resourceId.trim()],
  )

  return listBooklyResourceOptions(ownedId)
}


export async function downloadBooklyMeetingHistoryReport(
  accessToken: string,
  chatbotId: string,
  params: { from?: string; to?: string },
): Promise<Buffer> {
  const actorUserId = requireUserId(accessToken)
  const { tenantUserId } = await resolveTenantContext(actorUserId, "viewer")
  const ownedId = await requireOwnedChatbotId(tenantUserId, chatbotId)
  await requireFullCustomPlan(ownedId)

  const creds = await getDecryptedBooklyCredentials(ownedId)
  if (!creds) throw new AppError(503, "Connect a Bookly resource first before downloading its meeting history.")

  try {
    return await getMeetingHistoryReportPdf(creds, params)
  } catch (err) {
    if (err instanceof BooklyApiError && err.status === 0) {
      throw new AppError(502, "Could not reach the Bookly server. Try again in a moment.")
    }
    if (err instanceof BooklyApiError && (err.status === 401 || err.status === 403)) {
      throw new AppError(400, "This chatbot's Bookly API key is invalid or revoked. Reconnect Bookly and try again.")
    }
    throw new AppError(502, "Could not generate the Bookly meeting history report.")
  }
}
