import { actionRowToAction, maskActionForClient, reconcileHeadersTemplate, type ChatbotAction } from "../lib/actions.js"
import { verifyAccessToken } from "../lib/auth.js"
import { bumpChatbotCacheVersion } from "../lib/cache.js"
import { requireOwnedChatbotId } from "../lib/chatbotOwnership.js"
import { pool } from "../lib/db.js"
import { AppError } from "../lib/errors.js"
import type { ModelKey } from "../lib/plans.js"
import { resolveTenantContext } from "../lib/tenancy.js"
import {
  getCustomActionTopupModels,
  requireCrawlPlusCustomActions,
  requireCustomActionTopup,
} from "./customActionsAccess.service.js"
import type { CreateActionInput, UpdateActionInput } from "../validators/actions.validator.js"

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


const ACTION_COLUMNS =
  "id, chatbot_id, name, description, http_method, url_template, headers_template, body_template, parameters, created_at, updated_at"


export async function listActions(accessToken: string, chatbotId: string): Promise<ChatbotAction[]> {
  const db = requireDbPool()
  const actorUserId = requireUserId(accessToken)
  const { tenantUserId } = await resolveTenantContext(actorUserId, "viewer")
  const ownedId = await requireOwnedChatbotId(tenantUserId, chatbotId)
  await requireCrawlPlusCustomActions(ownedId)

  const { rows } = await db.query(
    `select ${ACTION_COLUMNS} from chatbot_actions where chatbot_id = $1 order by name asc`,
    [ownedId],
  )
  return rows.map(actionRowToAction).map(maskActionForClient)
}

export async function createAction(accessToken: string, chatbotId: string, input: CreateActionInput): Promise<ChatbotAction> {
  const db = requireDbPool()
  const actorUserId = requireUserId(accessToken)
  const { tenantUserId } = await resolveTenantContext(actorUserId, "admin")
  const ownedId = await requireOwnedChatbotId(tenantUserId, chatbotId)
  await requireCustomActionTopup(ownedId)

  try {
    const { rows } = await db.query(
      `insert into chatbot_actions
         (chatbot_id, name, description, http_method, url_template, headers_template, body_template, parameters)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       returning ${ACTION_COLUMNS}`,
      [
        ownedId,
        input.name,
        input.description,
        input.httpMethod,
        input.urlTemplate,
        JSON.stringify(input.headersTemplate),
        input.bodyTemplate ? JSON.stringify(input.bodyTemplate) : null,
        JSON.stringify(input.parameters),
      ],
    )
    await bumpChatbotCacheVersion(ownedId)
    return actionRowToAction(rows[0])
  } catch (err) {
    if (isUniqueViolation(err)) throw new AppError(409, "An action with that name already exists for this chatbot.")
    throw err
  }
}

export async function updateAction(
  accessToken: string,
  chatbotId: string,
  id: string,
  input: UpdateActionInput,
): Promise<ChatbotAction> {
  const db = requireDbPool()
  const actorUserId = requireUserId(accessToken)
  const { tenantUserId } = await resolveTenantContext(actorUserId, "admin")
  const ownedId = await requireOwnedChatbotId(tenantUserId, chatbotId)
  await requireCustomActionTopup(ownedId)

  try {
    // The client only ever sees masked header values (listActions), so a
    // save that didn't touch headers echoes the mask straight back —
    // reconcile against what's actually stored before writing, or saving
    // just the name would silently destroy the real Authorization header.
    const { rows: existingRows } = await db.query<{ headers_template: Record<string, string> | null }>(
      `select headers_template from chatbot_actions where id = $1 and chatbot_id = $2`,
      [id, ownedId],
    )
    if (!existingRows[0]) throw new AppError(404, "Action not found.")
    const resolvedHeaders = reconcileHeadersTemplate(existingRows[0].headers_template || {}, input.headersTemplate)

    const { rows } = await db.query(
      `update chatbot_actions
       set name = $1, description = $2, http_method = $3, url_template = $4,
           headers_template = $5, body_template = $6, parameters = $7, updated_at = now()
       where id = $8 and chatbot_id = $9
       returning ${ACTION_COLUMNS}`,
      [
        input.name,
        input.description,
        input.httpMethod,
        input.urlTemplate,
        JSON.stringify(resolvedHeaders),
        input.bodyTemplate ? JSON.stringify(input.bodyTemplate) : null,
        JSON.stringify(input.parameters),
        id,
        ownedId,
      ],
    )
    const row = rows[0]
    if (!row) throw new AppError(404, "Action not found.")
    await bumpChatbotCacheVersion(ownedId)
    return actionRowToAction(row)
  } catch (err) {
    if (isUniqueViolation(err)) throw new AppError(409, "An action with that name already exists for this chatbot.")
    throw err
  }
}

export async function deleteAction(accessToken: string, chatbotId: string, id: string): Promise<void> {
  const db = requireDbPool()
  const actorUserId = requireUserId(accessToken)
  const { tenantUserId } = await resolveTenantContext(actorUserId, "admin")
  const ownedId = await requireOwnedChatbotId(tenantUserId, chatbotId)

  const { rowCount } = await db.query("delete from chatbot_actions where id = $1 and chatbot_id = $2", [id, ownedId])
  if (!rowCount) throw new AppError(404, "Action not found.")
  await bumpChatbotCacheVersion(ownedId)
}


export interface AnsweringActions {
  actions: ChatbotAction[]
  eligibleModels: ModelKey[]
}

export async function getActionsForAnswering(chatbotId: string): Promise<AnsweringActions> {
  const db = requireDbPool()
  const eligibleModels = await getCustomActionTopupModels(chatbotId)
  if (eligibleModels.length === 0) return { actions: [], eligibleModels: [] }

  // Actions carrying customer credentials are never exposed to an AI provider
  // until this exact chatbot has its own encrypted backend connection.
  const { rows: integrationRows } = await db.query<{ connected: boolean }>(
    "select exists(select 1 from chatbot_integrations where chatbot_id = $1) as connected",
    [chatbotId],
  )
  if (!integrationRows[0]?.connected) return { actions: [], eligibleModels: [] }

  const { rows } = await db.query(
    `select ${ACTION_COLUMNS} from chatbot_actions where chatbot_id = $1 order by name asc`,
    [chatbotId],
  )
  return { actions: rows.map(actionRowToAction), eligibleModels }
}
