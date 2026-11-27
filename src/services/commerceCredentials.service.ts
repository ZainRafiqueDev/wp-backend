
import { hasIntegrationEncryption } from "../env.js"
import { verifyAccessToken } from "../lib/auth.js"
import { requireOwnedChatbotId } from "../lib/chatbotOwnership.js"
import { decryptSecret, encryptSecret } from "../lib/crypto.js"
import { pool } from "../lib/db.js"
import { AppError } from "../lib/errors.js"
import type { WooCommerceCredentials } from "../lib/woocommerce/connector.js"
import { getEntitlementForChatbot } from "./billing.service.js"
import { enqueueCatalogSync } from "../lib/commerceQueue.js"
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
    throw new AppError(503, "The WooCommerce commerce pipeline is not configured. Set INTEGRATION_ENCRYPTION_KEY.")
  }
}

export async function requireFullCustomPlan(chatbotId: string): Promise<void> {
  const entitlement = await getEntitlementForChatbot(chatbotId)
  if (entitlement.plan !== "full_custom") {
    throw new AppError(402, "The WooCommerce commerce pipeline requires the Full Custom plan. Upgrade to configure it.")
  }
}

function normalizeStoreUrl(value: string): string {
  return value.trim().replace(/\/+$/, "")
}

export interface WooCommerceConnectionStatus {
  connected: boolean
  storeUrl: string | null
  createdAt: string | null
}

export interface ConnectWooCommerceInput {
  storeUrl: string
  consumerKey: string
  consumerSecret: string
  webhookSecret: string
}

export async function getWooCommerceConnectionStatus(accessToken: string, chatbotId: string): Promise<WooCommerceConnectionStatus> {
  const db = requireDbPool()
  const actorUserId = requireUserId(accessToken)
  const { tenantUserId } = await resolveTenantContext(actorUserId, "viewer")
  const ownedId = await requireOwnedChatbotId(tenantUserId, chatbotId)

  const { rows } = await db.query<{ store_url: string; created_at: Date }>(
    "select store_url, created_at from chatbot_woocommerce_credentials where chatbot_id = $1",
    [ownedId],
  )
  const row = rows[0]
  return { connected: Boolean(row), storeUrl: row?.store_url ?? null, createdAt: row ? row.created_at.toISOString() : null }
}


export async function connectWooCommerce(
  accessToken: string,
  chatbotId: string,
  input: ConnectWooCommerceInput,
): Promise<WooCommerceConnectionStatus> {
  requireEncryption()
  const db = requireDbPool()
  const actorUserId = requireUserId(accessToken)
  const { tenantUserId } = await resolveTenantContext(actorUserId, "admin")
  const ownedId = await requireOwnedChatbotId(tenantUserId, chatbotId)
  await requireFullCustomPlan(ownedId)

  const storeUrl = normalizeStoreUrl(input.storeUrl)
  let parsed: URL
  try {
    parsed = new URL(storeUrl)
  } catch {
    throw new AppError(400, "Enter a valid store URL, like https://yourstore.com.")
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new AppError(400, "Enter a valid http or https store URL.")
  }

  const { rows } = await db.query<{ created_at: Date }>(
    `insert into chatbot_woocommerce_credentials
       (chatbot_id, store_url, consumer_key_encrypted, consumer_secret_encrypted, webhook_secret_encrypted)
     values ($1, $2, $3, $4, $5)
     on conflict (chatbot_id) do nothing
     returning created_at`,
    [ownedId, storeUrl, encryptSecret(input.consumerKey), encryptSecret(input.consumerSecret), encryptSecret(input.webhookSecret)],
  )
  if (!rows[0]) {
    throw new AppError(409, "This chatbot already has a connected WooCommerce store. Disconnect it first to reconnect.")
  }


  await enqueueCatalogSync({ chatbotId: ownedId })

  return { connected: true, storeUrl, createdAt: rows[0].created_at.toISOString() }
}

export async function disconnectWooCommerce(accessToken: string, chatbotId: string): Promise<void> {
  const db = requireDbPool()
  const actorUserId = requireUserId(accessToken)
  const { tenantUserId } = await resolveTenantContext(actorUserId, "admin")
  const ownedId = await requireOwnedChatbotId(tenantUserId, chatbotId)
  await db.query("delete from chatbot_woocommerce_credentials where chatbot_id = $1", [ownedId])
}


export async function getDecryptedWooCommerceCredentials(chatbotId: string): Promise<WooCommerceCredentials | null> {
  if (!hasIntegrationEncryption) return null
  const db = requireDbPool()
  const { rows } = await db.query<{ store_url: string; consumer_key_encrypted: string; consumer_secret_encrypted: string }>(
    "select store_url, consumer_key_encrypted, consumer_secret_encrypted from chatbot_woocommerce_credentials where chatbot_id = $1",
    [chatbotId],
  )
  const row = rows[0]
  if (!row) return null
  return {
    storeUrl: row.store_url,
    consumerKey: decryptSecret(row.consumer_key_encrypted),
    consumerSecret: decryptSecret(row.consumer_secret_encrypted),
  }
}


export async function getDecryptedWebhookSecret(chatbotId: string): Promise<string | null> {
  if (!hasIntegrationEncryption) return null
  const db = requireDbPool()
  const { rows } = await db.query<{ webhook_secret_encrypted: string }>(
    "select webhook_secret_encrypted from chatbot_woocommerce_credentials where chatbot_id = $1",
    [chatbotId],
  )
  const row = rows[0]
  return row ? decryptSecret(row.webhook_secret_encrypted) : null
}


export async function hasWooCommerceConnected(chatbotId: string): Promise<boolean> {
  const db = requireDbPool()
  const { rows } = await db.query("select 1 from chatbot_woocommerce_credentials where chatbot_id = $1", [chatbotId])
  return rows.length > 0
}
