import { bumpChatbotCacheVersion } from "../lib/cache.js"
import { verifyAccessToken } from "../lib/auth.js"
import { requireOwnedChatbotId } from "../lib/chatbotOwnership.js"
import { AppError } from "../lib/errors.js"
import { liveDataRowToEntry, type LiveDataEntry } from "../lib/liveData.js"
import { pool } from "../lib/db.js"
import { resolveTenantContext } from "../lib/tenancy.js"
import type { CreateLiveDataInput, UpdateLiveDataInput } from "../validators/liveData.validator.js"

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

function isUniqueViolation(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && "code" in err && (err as { code?: string }).code === "23505")
}


export async function listLiveData(accessToken: string, chatbotId: string): Promise<LiveDataEntry[]> {
  const db = requireDbPool()
  const actorUserId = requireUserId(accessToken)
  const { tenantUserId } = await resolveTenantContext(actorUserId, "viewer")
  const ownedId = await requireOwnedChatbotId(tenantUserId, chatbotId)

  const { rows } = await db.query(
    "select id, chatbot_id, key, value, updated_at from chatbot_live_data where chatbot_id = $1 order by key asc",
    [ownedId],
  )
  return rows.map(liveDataRowToEntry)
}

export async function createLiveData(accessToken: string, chatbotId: string, input: CreateLiveDataInput): Promise<LiveDataEntry> {
  const db = requireDbPool()
  const actorUserId = requireUserId(accessToken)
  const { tenantUserId } = await resolveTenantContext(actorUserId, "admin")
  const ownedId = await requireOwnedChatbotId(tenantUserId, chatbotId)

  try {
    const { rows } = await db.query(
      `insert into chatbot_live_data (chatbot_id, key, value)
       values ($1, $2, $3)
       returning id, chatbot_id, key, value, updated_at`,
      [ownedId, input.key, input.value],
    )
    await bumpChatbotCacheVersion(ownedId)
    return liveDataRowToEntry(rows[0])
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new AppError(409, "A live-data entry with that key already exists.")
    }
    throw err
  }
}

export async function updateLiveData(
  accessToken: string,
  chatbotId: string,
  id: string,
  input: UpdateLiveDataInput,
): Promise<LiveDataEntry> {
  const db = requireDbPool()
  const actorUserId = requireUserId(accessToken)
  const { tenantUserId } = await resolveTenantContext(actorUserId, "admin")
  const ownedId = await requireOwnedChatbotId(tenantUserId, chatbotId)

  try {

    const { rows } = await db.query(
      `update chatbot_live_data set key = coalesce($1, key), value = $2, updated_at = now()
       where id = $3 and chatbot_id = $4
       returning id, chatbot_id, key, value, updated_at`,
      [input.key ?? null, input.value, id, ownedId],
    )
    const row = rows[0]
    if (!row) throw new AppError(404, "Live-data entry not found.")
    await bumpChatbotCacheVersion(ownedId)
    return liveDataRowToEntry(row)
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new AppError(409, "A live-data entry with that key already exists.")
    }
    throw err
  }
}

export async function deleteLiveData(accessToken: string, chatbotId: string, id: string): Promise<void> {
  const db = requireDbPool()
  const actorUserId = requireUserId(accessToken)
  const { tenantUserId } = await resolveTenantContext(actorUserId, "admin")
  const ownedId = await requireOwnedChatbotId(tenantUserId, chatbotId)

  const { rowCount } = await db.query("delete from chatbot_live_data where id = $1 and chatbot_id = $2", [id, ownedId])
  if (!rowCount) throw new AppError(404, "Live-data entry not found.")
  await bumpChatbotCacheVersion(ownedId)
}


export async function getLiveDataForAnswering(chatbotId: string): Promise<{ key: string; value: string }[]> {
  const db = requireDbPool()
  const { rows } = await db.query<{ key: string; value: string }>(
    "select key, value from chatbot_live_data where chatbot_id = $1 order by key asc",
    [chatbotId],
  )
  return rows
}
