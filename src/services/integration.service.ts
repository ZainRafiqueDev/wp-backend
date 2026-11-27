import { hasIntegrationEncryption } from "../env.js"
import { verifyAccessToken } from "../lib/auth.js"
import { bumpChatbotCacheVersion } from "../lib/cache.js"
import { requireOwnedChatbotId } from "../lib/chatbotOwnership.js"
import { decryptSecret, encryptSecret } from "../lib/crypto.js"
import { pool } from "../lib/db.js"
import { AppError } from "../lib/errors.js"
import { resolveTenantContext } from "../lib/tenancy.js"
import { requireCustomActionTopup } from "./customActionsAccess.service.js"

function requireDbPool() {
  if (!pool) {
    throw new AppError(503, "Database is not configured. Set DATABASE_URL and JWT_SECRET.")
  }
  return pool
}

function requireUserId(accessToken: string): string {
  const userId = verifyAccessToken(accessToken)
  if (!userId) throw new AppError(401, "Please sign in again.")
  return userId
}

function requireEncryption() {
  if (!hasIntegrationEncryption) {
    throw new AppError(503, "Backend integration is not configured. Set INTEGRATION_ENCRYPTION_KEY.")
  }
}


export interface IntegrationStatus {
  connected: boolean
  updatedAt: string | null
  
  apiBaseUrl: string | null
}

function normalizeApiBaseUrl(value: string): string {
  return value.replace(/\/+$/, "")
}


export async function getIntegrationStatus(accessToken: string, chatbotId: string): Promise<IntegrationStatus> {
  const db = requireDbPool()
  const actorUserId = requireUserId(accessToken)
  const { tenantUserId } = await resolveTenantContext(actorUserId, "viewer")
  const ownedId = await requireOwnedChatbotId(tenantUserId, chatbotId)

  const { rows } = await db.query<{ updated_at: Date; api_base_url: string | null }>(
    "select updated_at, api_base_url from chatbot_integrations where chatbot_id = $1",
    [ownedId],
  )
  const row = rows[0]
  return {
    connected: Boolean(row),
    updatedAt: row ? row.updated_at.toISOString() : null,
    apiBaseUrl: row?.api_base_url ?? null,
  }
}


export async function upsertIntegration(
  accessToken: string,
  chatbotId: string,
  apiKey?: string,
  apiBaseUrl?: string,
): Promise<IntegrationStatus> {
  requireEncryption()
  const db = requireDbPool()
  const actorUserId = requireUserId(accessToken)
  const { tenantUserId } = await resolveTenantContext(actorUserId, "admin")
  const ownedId = await requireOwnedChatbotId(tenantUserId, chatbotId)
  await requireCustomActionTopup(ownedId)


  let existingEncryptedKey: string | null = null
  if (apiKey === undefined) {
    const { rows: existing } = await db.query<{ api_key_encrypted: string }>(
      "select api_key_encrypted from chatbot_integrations where chatbot_id = $1",
      [ownedId],
    )
    if (!existing[0]) throw new AppError(400, "An API key is required to connect for the first time.")
    existingEncryptedKey = existing[0].api_key_encrypted
  }

  const encrypted = apiKey === undefined ? existingEncryptedKey : encryptSecret(apiKey)
  const normalizedBaseUrl = apiBaseUrl === undefined ? null : normalizeApiBaseUrl(apiBaseUrl) || null
  const { rows } = await db.query<{ updated_at: Date; api_base_url: string | null }>(
    `insert into chatbot_integrations (chatbot_id, api_key_encrypted, api_base_url)
     values ($1, $2, $3)
     on conflict (chatbot_id) do update set
       api_key_encrypted = case when $4 then excluded.api_key_encrypted else chatbot_integrations.api_key_encrypted end,
       api_base_url = case when $5 then excluded.api_base_url else chatbot_integrations.api_base_url end,
       updated_at = now()
     returning updated_at, api_base_url`,
    [ownedId, encrypted, normalizedBaseUrl, apiKey !== undefined, apiBaseUrl !== undefined],
  )

  await bumpChatbotCacheVersion(ownedId)
  return { connected: true, updatedAt: rows[0].updated_at.toISOString(), apiBaseUrl: rows[0].api_base_url }
}

export async function deleteIntegration(accessToken: string, chatbotId: string): Promise<void> {
  const db = requireDbPool()
  const actorUserId = requireUserId(accessToken)
  const { tenantUserId } = await resolveTenantContext(actorUserId, "admin")
  const ownedId = await requireOwnedChatbotId(tenantUserId, chatbotId)

  await db.query("delete from chatbot_integrations where chatbot_id = $1", [ownedId])
  await bumpChatbotCacheVersion(ownedId)
}


export async function getDecryptedApiKeyForChatbot(chatbotId: string): Promise<string | null> {
  if (!hasIntegrationEncryption) return null
  const db = requireDbPool()

  const { rows } = await db.query<{ api_key_encrypted: string }>(
    "select api_key_encrypted from chatbot_integrations where chatbot_id = $1",
    [chatbotId],
  )
  const row = rows[0]
  return row ? decryptSecret(row.api_key_encrypted) : null
}

export interface BackendLink {
  apiBaseUrl: string
  apiKey: string | null
}


export async function getBackendLinkForChatbot(chatbotId: string): Promise<BackendLink | null> {
  const db = requireDbPool()
  const { rows } = await db.query<{ api_base_url: string | null; api_key_encrypted: string }>(
    "select api_base_url, api_key_encrypted from chatbot_integrations where chatbot_id = $1",
    [chatbotId],
  )
  const row = rows[0]
  if (!row || !row.api_base_url) return null
  return {
    apiBaseUrl: row.api_base_url,
    apiKey: hasIntegrationEncryption ? decryptSecret(row.api_key_encrypted) : null,
  }
}
