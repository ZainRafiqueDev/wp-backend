import { verifyAccessToken } from "../lib/auth.js"
import { bumpChatbotCacheVersion } from "../lib/cache.js"
import { requireOwnedChatbotId } from "../lib/chatbotOwnership.js"
import { pool } from "../lib/db.js"
import { AppError } from "../lib/errors.js"
import { log } from "../lib/logger.js"
import { resolveTenantContext, type EffectiveRole } from "../lib/tenancy.js"
import {
  formatOKFAnswer,
  isOkfType,
  toOkfMarkdownFile,
  type OKFConcept,
  type OKFCreatedBy,
  type OKFType,
} from "../lib/okf.js"
import { zipStore } from "../lib/zipStore.js"
import { activeEmbeddingIdentity, embedText, toPgVectorLiteral } from "./embeddings.service.js"

export type OkfConceptInput = {
  type: OKFType
  title: string
  description?: string | null
  tags?: string[]
  resourceUrl?: string | null
  bodyMd: string
  createdBy?: OKFCreatedBy
  sourceDocumentId?: string | null
}

export type OkfListFilters = {
  type?: OKFType
  status?: "active" | "pending" | "inactive"
  q?: string
}

type ConceptRow = {
  id: string
  chatbot_id: string
  type: string
  title: string
  description: string | null
  tags: string[]
  resource_url: string | null
  okf_version: string
  body_md: string
  is_active: boolean
  created_by: string
  approved_at: Date | null
  source_document_id: string | null
  served_count: number
  created_at: Date
  updated_at: Date
}

const COLUMNS = `id, chatbot_id, type, title, description, tags, resource_url, okf_version, body_md,
  is_active, created_by, approved_at, source_document_id, served_count, created_at, updated_at`

function requireDb() {
  if (!pool) throw new AppError(503, "Database is not configured.")
  return pool
}

function requireUserId(accessToken: string): string {
  const userId = verifyAccessToken(accessToken)
  if (!userId) throw new AppError(401, "Please sign in again.")
  return userId
}

function mapConcept(row: ConceptRow): OKFConcept {
  return {
    id: row.id,
    chatbotId: row.chatbot_id,
    type: row.type as OKFType,
    title: row.title,
    description: row.description,
    tags: row.tags ?? [],
    resourceUrl: row.resource_url,
    okfVersion: row.okf_version,
    bodyMd: row.body_md,
    isActive: row.is_active,
    createdBy: row.created_by as OKFCreatedBy,
    approvedAt: row.approved_at ? row.approved_at.toISOString() : null,
    sourceDocumentId: row.source_document_id,
    servedCount: Number(row.served_count ?? 0),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }
}

async function own(
  accessToken: string,
  chatbotId: string,
  requiredRole: EffectiveRole,
): Promise<{ userId: string; chatbotId: string }> {
  const actorUserId = requireUserId(accessToken)
  const { tenantUserId } = await resolveTenantContext(actorUserId, requiredRole)
  // Field stays named `userId` for callers writing audit entries (okf_audit_log.changed_by)
  // — it must be the real actor, never the resolved tenant/owner.
  return { userId: actorUserId, chatbotId: await requireOwnedChatbotId(tenantUserId, chatbotId) }
}

async function writeAudit(input: {
  chatbotId: string
  conceptId: string | null
  action: string
  changedBy: string
  changeSummary: string
  previousBodyMd?: string | null
}): Promise<void> {
  await requireDb().query(
    `insert into okf_audit_log (chatbot_id, concept_id, action, changed_by, change_summary, previous_body_md)
     values ($1, $2, $3, $4, $5, $6)`,
    [input.chatbotId, input.conceptId, input.action, input.changedBy, input.changeSummary, input.previousBodyMd ?? null],
  )
}

export async function rebuildIndex(chatbotId: string): Promise<void> {
  const db = requireDb()
  const { rows } = await db.query<{ type: string; title: string }>(
    `select type, title from okf_concepts
      where chatbot_id = $1 and is_active and approved_at is not null
      order by type, title`,
    [chatbotId],
  )
  const lines = ["# OKF Index", "", `Concepts: ${rows.length}`, ""]
  let current = ""
  for (const row of rows) {
    if (row.type !== current) {
      current = row.type
      lines.push(`## ${current}`, "")
    }
    lines.push(`- ${row.title}`)
  }
  const indexMd = `${lines.join("\n")}\n`
  await db.query(
    `insert into okf_index (chatbot_id, index_md, concept_count, last_rebuilt_at)
     values ($1, $2, $3, now())
     on conflict (chatbot_id) do update
       set index_md = excluded.index_md, concept_count = excluded.concept_count, last_rebuilt_at = now()`,
    [chatbotId, indexMd, rows.length],
  )
}

export async function getIndex(accessToken: string, chatbotId: string): Promise<{ indexMd: string; conceptCount: number }> {
  const ownedId = (await own(accessToken, chatbotId, "viewer")).chatbotId
  const { rows } = await requireDb().query<{ index_md: string; concept_count: number }>(
    `select index_md, concept_count from okf_index where chatbot_id = $1`,
    [ownedId],
  )
  if (!rows[0]) {
    await rebuildIndex(ownedId)
    const again = await requireDb().query<{ index_md: string; concept_count: number }>(
      `select index_md, concept_count from okf_index where chatbot_id = $1`,
      [ownedId],
    )
    return { indexMd: again.rows[0]?.index_md ?? "# OKF Index\n", conceptCount: Number(again.rows[0]?.concept_count ?? 0) }
  }
  return { indexMd: rows[0].index_md, conceptCount: Number(rows[0].concept_count) }
}

export async function embedConcept(conceptId: string): Promise<void> {
  const db = requireDb()
  const { rows } = await db.query<{ title: string; description: string | null; body_md: string; chatbot_id: string }>(
    `select title, description, body_md, chatbot_id from okf_concepts where id = $1`,
    [conceptId],
  )
  if (!rows[0]) return
  const text = `${rows[0].title}\n${rows[0].description ?? ""}\n${rows[0].body_md.slice(0, 500)}`
  const vector = await embedText(text, { chatbotId: rows[0].chatbot_id, purpose: "document_query" }).catch((err) => {
    log().warn(
      { event: "okf.embed_failed", conceptId, err: err instanceof Error ? err.message : String(err) },
      "okf concept embed failed",
    )
    return null
  })
  if (!vector) return
  const identity = activeEmbeddingIdentity()
  await db.query(
    `update okf_concepts
        set embedding = $2::vector, embedding_model = $3, embedding_updated_at = now()
      where id = $1`,
    [conceptId, toPgVectorLiteral(vector), identity.model],
  )
}

async function insertConcept(chatbotId: string, input: OkfConceptInput): Promise<OKFConcept> {
  if (!isOkfType(input.type)) throw new AppError(400, "Unsupported OKF type.")
  const title = input.title.trim()
  const bodyMd = input.bodyMd.trim()
  if (!title) throw new AppError(400, "Title is required.")
  if (title.length > 100) throw new AppError(400, "Title must be 100 characters or fewer.")
  if (!bodyMd) throw new AppError(400, "body_md cannot be empty.")
  if (bodyMd.length > 10_000) throw new AppError(400, "body_md must be 10,000 characters or fewer.")
  const { rows } = await requireDb().query<ConceptRow>(
    `insert into okf_concepts (
       chatbot_id, type, title, description, tags, resource_url, body_md, created_by, source_document_id
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     returning ${COLUMNS}`,
    [
      chatbotId,
      input.type,
      title,
      input.description?.trim() || null,
      input.tags ?? [],
      input.resourceUrl?.trim() || null,
      bodyMd,
      input.createdBy ?? "human",
      input.sourceDocumentId ?? null,
    ],
  )
  return mapConcept(rows[0])
}

export async function createConcept(accessToken: string, chatbotId: string, input: OkfConceptInput): Promise<OKFConcept> {
  const { userId, chatbotId: ownedId } = await own(accessToken, chatbotId, "admin")
  const concept = await insertConcept(ownedId, { ...input, createdBy: "human" })
  await writeAudit({
    chatbotId: ownedId,
    conceptId: concept.id,
    action: "created",
    changedBy: userId,
    changeSummary: `created ${concept.type}: ${concept.title}`,
  })
  await rebuildIndex(ownedId)
  return concept
}

export async function createSuggestedConcepts(
  chatbotId: string,
  inputs: OkfConceptInput[],
  sourceDocumentId: string | null,
): Promise<OKFConcept[]> {
  const created: OKFConcept[] = []
  for (const input of inputs) {
    const concept = await insertConcept(chatbotId, {
      ...input,
      createdBy: "ai_extracted",
      sourceDocumentId,
    })
    await writeAudit({
      chatbotId,
      conceptId: concept.id,
      action: "ai_suggested",
      changedBy: "ai_extracted",
      changeSummary: `suggested ${concept.type}: ${concept.title}`,
    })
    created.push(concept)
  }
  return created
}

export async function updateConcept(
  accessToken: string,
  chatbotId: string,
  conceptId: string,
  input: Partial<OkfConceptInput>,
): Promise<OKFConcept> {
  const { userId, chatbotId: ownedId } = await own(accessToken, chatbotId, "admin")
  const existing = await loadConcept(ownedId, conceptId)
  const nextType = input.type ?? existing.type
  const nextTitle = input.title?.trim() ?? existing.title
  const nextBody = input.bodyMd?.trim() ?? existing.bodyMd
  if (!nextBody) throw new AppError(400, "body_md cannot be empty.")
  if (nextTitle.length > 100) throw new AppError(400, "Title must be 100 characters or fewer.")
  if (nextBody.length > 10_000) throw new AppError(400, "body_md must be 10,000 characters or fewer.")
  if (input.type && !isOkfType(input.type)) throw new AppError(400, "Unsupported OKF type.")

  const { rows } = await requireDb().query<ConceptRow>(
    `update okf_concepts
        set type = $3, title = $4, description = $5, tags = $6, resource_url = $7, body_md = $8, updated_at = now()
      where id = $1 and chatbot_id = $2
      returning ${COLUMNS}`,
    [
      conceptId,
      ownedId,
      nextType,
      nextTitle,
      input.description !== undefined ? input.description?.trim() || null : existing.description,
      input.tags ?? existing.tags,
      input.resourceUrl !== undefined ? input.resourceUrl?.trim() || null : existing.resourceUrl,
      nextBody,
    ],
  )
  if (!rows[0]) throw new AppError(404, "OKF concept not found.")
  await writeAudit({
    chatbotId: ownedId,
    conceptId,
    action: "updated",
    changedBy: userId,
    changeSummary: `updated ${nextTitle}`,
    previousBodyMd: existing.bodyMd,
  })
  const contentChanged =
    nextTitle !== existing.title || nextBody !== existing.bodyMd || (input.description !== undefined && input.description !== existing.description)
  if (contentChanged && rows[0].approved_at) {
    await embedConcept(conceptId)
  }
  await rebuildIndex(ownedId)
  await bumpChatbotCacheVersion(ownedId)
  return mapConcept(rows[0])
}

export async function approveConcept(accessToken: string, chatbotId: string, conceptId: string): Promise<OKFConcept> {
  const { userId, chatbotId: ownedId } = await own(accessToken, chatbotId, "admin")
  const existing = await loadConcept(ownedId, conceptId)
  if (!existing.bodyMd.trim()) throw new AppError(400, "Cannot approve a concept with empty body_md.")
  if (!existing.isActive) throw new AppError(409, "Deactivated concepts cannot be approved.")
  const { rows } = await requireDb().query<ConceptRow>(
    `update okf_concepts set approved_at = now(), updated_at = now()
      where id = $1 and chatbot_id = $2
      returning ${COLUMNS}`,
    [conceptId, ownedId],
  )
  await writeAudit({
    chatbotId: ownedId,
    conceptId,
    action: "approved",
    changedBy: userId,
    changeSummary: `approved ${existing.title}`,
    previousBodyMd: existing.bodyMd,
  })
  await embedConcept(conceptId)
  await rebuildIndex(ownedId)
  await bumpChatbotCacheVersion(ownedId)
  return mapConcept(rows[0])
}

export async function deactivateConcept(accessToken: string, chatbotId: string, conceptId: string): Promise<void> {
  const { userId, chatbotId: ownedId } = await own(accessToken, chatbotId, "admin")
  const existing = await loadConcept(ownedId, conceptId)
  const { rowCount } = await requireDb().query(
    `update okf_concepts set is_active = false, updated_at = now() where id = $1 and chatbot_id = $2`,
    [conceptId, ownedId],
  )
  if (!rowCount) throw new AppError(404, "OKF concept not found.")
  await writeAudit({
    chatbotId: ownedId,
    conceptId,
    action: "deactivated",
    changedBy: userId,
    changeSummary: `deactivated ${existing.title}`,
    previousBodyMd: existing.bodyMd,
  })
  await rebuildIndex(ownedId)
  await bumpChatbotCacheVersion(ownedId)
}

export async function restoreConcept(
  accessToken: string,
  chatbotId: string,
  conceptId: string,
  auditId: string,
): Promise<OKFConcept> {
  const { userId, chatbotId: ownedId } = await own(accessToken, chatbotId, "admin")
  const { rows: audit } = await requireDb().query<{ previous_body_md: string | null }>(
    `select previous_body_md from okf_audit_log where id = $1 and chatbot_id = $2 and concept_id = $3`,
    [auditId, ownedId, conceptId],
  )
  if (!audit[0]?.previous_body_md) throw new AppError(404, "Audit version not found.")
  return updateConcept(accessToken, chatbotId, conceptId, { bodyMd: audit[0].previous_body_md }).then(async (concept) => {
    await writeAudit({
      chatbotId: ownedId,
      conceptId,
      action: "restored",
      changedBy: userId,
      changeSummary: `restored from ${auditId}`,
    })
    return concept
  })
}

export async function listConcepts(accessToken: string, chatbotId: string, filters: OkfListFilters = {}): Promise<OKFConcept[]> {
  const ownedId = (await own(accessToken, chatbotId, "viewer")).chatbotId
  const clauses = ["chatbot_id = $1"]
  const values: unknown[] = [ownedId]
  if (filters.type) {
    values.push(filters.type)
    clauses.push(`type = $${values.length}`)
  }
  if (filters.status === "pending") clauses.push("approved_at is null and is_active")
  else if (filters.status === "inactive") clauses.push("not is_active")
  else if (filters.status === "active") clauses.push("is_active and approved_at is not null")
  if (filters.q) {
    values.push(`%${filters.q.trim().toLowerCase()}%`)
    clauses.push(`lower(title) like $${values.length}`)
  }
  const { rows } = await requireDb().query<ConceptRow>(
    `select ${COLUMNS} from okf_concepts where ${clauses.join(" and ")} order by updated_at desc`,
    values,
  )
  return rows.map(mapConcept)
}

export async function getConcept(accessToken: string, chatbotId: string, conceptId: string): Promise<OKFConcept> {
  const ownedId = (await own(accessToken, chatbotId, "viewer")).chatbotId
  return loadConcept(ownedId, conceptId)
}

async function loadConcept(chatbotId: string, conceptId: string): Promise<OKFConcept> {
  const { rows } = await requireDb().query<ConceptRow>(
    `select ${COLUMNS} from okf_concepts where id = $1 and chatbot_id = $2`,
    [conceptId, chatbotId],
  )
  if (!rows[0]) throw new AppError(404, "OKF concept not found.")
  return mapConcept(rows[0])
}

export async function listAudit(accessToken: string, chatbotId: string, conceptId: string) {
  const ownedId = (await own(accessToken, chatbotId, "admin")).chatbotId
  await loadConcept(ownedId, conceptId)
  const { rows } = await requireDb().query(
    `select id, action, changed_by, change_summary, previous_body_md, created_at
       from okf_audit_log where chatbot_id = $1 and concept_id = $2
       order by created_at desc`,
    [ownedId, conceptId],
  )
  return rows.map((row) => ({
    id: row.id as string,
    action: row.action as string,
    changedBy: row.changed_by as string | null,
    changeSummary: row.change_summary as string | null,
    previousBodyMd: row.previous_body_md as string | null,
    createdAt: (row.created_at as Date).toISOString(),
  }))
}

export async function exportBundle(accessToken: string, chatbotId: string): Promise<{ filename: string; bytes: Buffer }> {
  const ownedId = (await own(accessToken, chatbotId, "viewer")).chatbotId
  const { rows } = await requireDb().query<ConceptRow>(
    `select ${COLUMNS} from okf_concepts where chatbot_id = $1 and is_active order by type, title`,
    [ownedId],
  )
  const used = new Set<string>()
  const files = rows.map((row) => {
    const concept = mapConcept(row)
    let slug = concept.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "concept"
    if (used.has(slug)) slug = `${slug}-${concept.id.slice(0, 8)}`
    used.add(slug)
    return { name: `${concept.type}/${slug}.md`, content: toOkfMarkdownFile(concept) }
  })
  return { filename: `okf-bundle-${ownedId.slice(0, 8)}.zip`, bytes: zipStore(files) }
}

export async function overview(accessToken: string, chatbotId: string) {
  const ownedId = (await own(accessToken, chatbotId, "viewer")).chatbotId
  const db = requireDb()
  const counts = await db.query<{ type: string; n: string; pending: string; inactive: string }>(
    `select type,
            count(*) filter (where is_active and approved_at is not null)::text as n,
            count(*) filter (where is_active and approved_at is null)::text as pending,
            count(*) filter (where not is_active)::text as inactive
       from okf_concepts where chatbot_id = $1 group by type`,
    [ownedId],
  )
  const stamp = await db.query<{ updated_at: Date | null }>(
    `select max(updated_at) as updated_at from okf_concepts where chatbot_id = $1`,
    [ownedId],
  )
  return {
    byType: counts.rows.map((row) => ({
      type: row.type,
      live: Number(row.n),
      pending: Number(row.pending),
      inactive: Number(row.inactive),
    })),
    lastUpdated: stamp.rows[0]?.updated_at?.toISOString() ?? null,
  }
}

export function previewOkfAnswer(concept: OKFConcept, query: string): string {
  return formatOKFAnswer(concept, query)
}
