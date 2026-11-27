import { env } from "../env.js"
import { pool } from "../lib/db.js"
import { log } from "../lib/logger.js"
import {
  bodyAnswersQuery,
  classifyOkfQueryType,
  formatOKFAnswer,
  levenshtein,
  normalizeOkfTitle,
  type OKFConcept,
  type OKFType,
} from "../lib/okf.js"
import { runWithSystemContext } from "../lib/tenantContext.js"
import { embedText, toPgVectorLiteral } from "./embeddings.service.js"

export type OKFRoutingMethod = "exact_title" | "semantic" | "type_hint" | "rag" | "okf_fallback_rag"

export type OKFRouterResult = {
  matched: boolean
  concept?: OKFConcept
  confidence?: number
  answer?: string
  citationUrl?: string | null
  routingMethod: OKFRoutingMethod
}

type LiveRow = {
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
  similarity?: number
}

function requireDb() {
  return pool
}

function toConcept(row: LiveRow): OKFConcept {
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
    createdBy: row.created_by as OKFConcept["createdBy"],
    approvedAt: row.approved_at ? row.approved_at.toISOString() : null,
    sourceDocumentId: row.source_document_id,
    servedCount: Number(row.served_count ?? 0),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }
}

const LIVE = `id, chatbot_id, type, title, description, tags, resource_url, okf_version, body_md,
  is_active, created_by, approved_at, source_document_id, served_count, created_at, updated_at`

async function loadLiveConcepts(chatbotId: string): Promise<LiveRow[]> {
  const db = requireDb()
  if (!db) return []
  const { rows } = await db.query<LiveRow>(
    `select ${LIVE} from okf_concepts
      where chatbot_id = $1 and is_active = true and approved_at is not null`,
    [chatbotId],
  )
  return rows
}

function exactTitleMatch(query: string, concepts: LiveRow[]): { row: LiveRow; confidence: number } | null {
  const needle = normalizeOkfTitle(query)
  if (!needle) return null
  let best: LiveRow | null = null
  let bestDist = Infinity
  for (const row of concepts) {
    const dist = levenshtein(needle, normalizeOkfTitle(row.title))
    if (dist < bestDist) {
      bestDist = dist
      best = row
    }
  }
  if (!best || bestDist > 2) return null
  return { row: best, confidence: env.okfExactTitleThreshold }
}

async function semanticMatch(
  chatbotId: string,
  query: string,
  typeHint: OKFType | null,
): Promise<{ row: LiveRow; confidence: number; method: "semantic" | "type_hint" } | null> {
  const db = requireDb()
  if (!db) return null
  const vector = await embedText(query, { chatbotId, purpose: "document_query" }).catch(() => null)
  if (!vector) return null
  const { rows } = await db.query<LiveRow>(
    `select ${LIVE}, (1 - (embedding <=> $2::vector))::float as similarity
       from okf_concepts
      where chatbot_id = $1
        and is_active = true
        and approved_at is not null
        and embedding is not null
      order by embedding <=> $2::vector
      limit 5`,
    [chatbotId, toPgVectorLiteral(vector)],
  )
  const top = rows[0]
  if (!top || top.similarity == null) return null
  if (top.similarity >= env.okfSemanticThreshold) {
    return { row: top, confidence: top.similarity, method: "semantic" }
  }
  if (typeHint && top.type === typeHint && top.similarity >= env.okfTypeHintThreshold) {
    return { row: top, confidence: top.similarity, method: "type_hint" }
  }
  return null
}

function buildMatch(row: LiveRow, query: string, confidence: number, method: OKFRoutingMethod): OKFRouterResult {
  const concept = toConcept(row)
  if (method !== "exact_title" && !bodyAnswersQuery(concept.bodyMd, query)) {
    return { matched: false, concept, confidence, routingMethod: "okf_fallback_rag" }
  }
  return {
    matched: true,
    concept,
    confidence,
    answer: formatOKFAnswer(concept, query),
    citationUrl: concept.resourceUrl,
    routingMethod: method,
  }
}

export async function routeQuery(
  chatbotId: string,
  rewrittenQuery: string,
  queryType?: string,
): Promise<OKFRouterResult> {
  const miss: OKFRouterResult = { matched: false, routingMethod: "rag" }
  try {
    const concepts = await loadLiveConcepts(chatbotId)
    if (concepts.length === 0) {
      await logRouting(chatbotId, miss)
      return miss
    }

    const exact = exactTitleMatch(rewrittenQuery, concepts)
    if (exact) {
      const result = buildMatch(exact.row, rewrittenQuery, exact.confidence, "exact_title")
      await logRouting(chatbotId, result)
      return result
    }

    const hinted = (queryType && ["Policy", "PricingTable", "OperatingInfo", "Procedure", "FAQ", "ProductSpec", "SLADefinition", "Glossary"].includes(queryType)
      ? (queryType as OKFType)
      : classifyOkfQueryType(rewrittenQuery))
    const semantic = await semanticMatch(chatbotId, rewrittenQuery, hinted)
    if (semantic) {
      const result = buildMatch(semantic.row, rewrittenQuery, semantic.confidence, semantic.method)
      await logRouting(chatbotId, result)
      return result
    }

    await logRouting(chatbotId, miss)
    return miss
  } catch (err) {
    log().warn(
      { event: "okf.router_failed", chatbotId, err: err instanceof Error ? err.message : String(err) },
      "okf router failed open to RAG",
    )
    return miss
  }
}

export async function logRouting(chatbotId: string, result: OKFRouterResult): Promise<void> {
  const db = requireDb()
  if (!db) return
  const method = result.routingMethod
  log().info(
    {
      event: "okf.routing_decision",
      chatbotId,
      matched: result.matched,
      confidence: result.confidence ?? null,
      routingMethod: method,
      conceptId: result.concept?.id ?? null,
    },
    "okf routing decision",
  )
  try {
    await db.query(
      `insert into okf_routing_log (chatbot_id, concept_id, matched, confidence, routing_method)
       values ($1, $2, $3, $4, $5)`,
      [chatbotId, result.concept?.id ?? null, result.matched, result.confidence ?? null, method],
    )
    if (result.matched && result.concept?.id) {
      await db.query(`update okf_concepts set served_count = served_count + 1 where id = $1`, [result.concept.id])
    }
    await persistEvalRow(chatbotId, result)
  } catch (err) {
    log().warn(
      { event: "okf.routing_log_failed", chatbotId, err: err instanceof Error ? err.message : String(err) },
      "okf routing log failed",
    )
  }
}

async function persistEvalRow(chatbotId: string, result: OKFRouterResult): Promise<void> {
  const db = requireDb()
  if (!db) return
  await runWithSystemContext(async () => {
    await db.query(
      `insert into rag_evaluations (
         chatbot_id, pair_count, grounded_answer_rate, hallucination_rate, isolation_violations,
         okf_routed, okf_concept_id, okf_confidence, routing_method
       ) values ($1, 0, $2, 0, 0, $3, $4, $5, $6)`,
      [
        chatbotId,
        result.matched ? 1 : 0,
        result.matched,
        result.concept?.id ?? null,
        result.confidence ?? null,
        result.matched ? "okf" : result.routingMethod === "okf_fallback_rag" ? "okf_fallback_rag" : "rag",
      ],
    )
  })
}
