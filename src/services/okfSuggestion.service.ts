import { completeCheaply, type AiUsage } from "../lib/ai.js"
import { cheapCallAuthorizer } from "../lib/cheapCallBilling.js"
import { estimateCostUsd } from "../lib/aiPricing.js"
import { env } from "../env.js"
import { log } from "../lib/logger.js"
import { isOkfType, type OKFConcept, type OKFType } from "../lib/okf.js"
import { isLikelyOkfRelevantPage, scoreOkfRelevance } from "../lib/okfPageRelevance.js"
import { createSuggestedConcepts } from "./okf.service.js"
import { createNotification } from "./notification.service.js"
import { recordUsage } from "./usage.service.js"
import { pool } from "../lib/db.js"

const EXTRACTION_SYSTEM = "Output ONLY valid JSON. No markdown fences."

function extractionPrompt(documentText: string): string {
  return `You are analyzing a business document to identify canonical facts that should be
stored as precise, citable knowledge (not retrieved probabilistically).

Document text:
${documentText.slice(0, 3000)}

Identify up to 5 pieces of information that:
1. Have a single correct answer (not open-ended or contextual)
2. Would be dangerous to get wrong (prices, policies, deadlines, procedures)
3. Are stable facts that won't change daily
4. Could be clearly titled and typed

For each, output JSON:
{
  "concepts": [
    {
      "type": "Policy|PricingTable|OperatingInfo|Procedure|FAQ|ProductSpec|SLADefinition|Glossary",
      "title": "Short descriptive title",
      "description": "One sentence describing what this concept covers",
      "tags": ["tag1", "tag2"],
      "body_md": "Full markdown content preserving structure (tables, lists, headings)"
    }
  ]
}

Output ONLY valid JSON. If no canonical facts exist, output {"concepts": []}.`
}

type ParsedConcept = {
  type: OKFType
  title: string
  description?: string
  tags?: string[]
  body_md: string
}

function parseConcepts(raw: string): ParsedConcept[] {
  const trimmed = raw.trim().replace(/^```json\s*/i, "").replace(/```$/i, "").trim()
  const start = trimmed.indexOf("{")
  const end = trimmed.lastIndexOf("}")
  if (start < 0 || end <= start) return []
  let parsed: { concepts?: unknown }
  try {
    parsed = JSON.parse(trimmed.slice(start, end + 1)) as { concepts?: unknown }
  } catch {
    return []
  }
  if (!Array.isArray(parsed.concepts)) return []
  const out: ParsedConcept[] = []
  for (const item of parsed.concepts) {
    if (!item || typeof item !== "object") continue
    const rec = item as Record<string, unknown>
    const type = typeof rec.type === "string" ? rec.type : ""
    const title = typeof rec.title === "string" ? rec.title.trim() : ""
    const body = typeof rec.body_md === "string" ? rec.body_md.trim() : ""
    if (!isOkfType(type) || !title || !body) continue
    out.push({
      type,
      title: title.slice(0, 100),
      description: typeof rec.description === "string" ? rec.description : undefined,
      tags: Array.isArray(rec.tags) ? rec.tags.filter((t): t is string => typeof t === "string").slice(0, 8) : [],
      body_md: body.slice(0, 10_000),
    })
    if (out.length >= 5) break
  }
  return out
}

// Shared by both entry points below (document upload, crawled page) — the
// only difference between them is where the source text comes from and
// what provenance (sourceDocumentId vs resourceUrl) gets attached to the
// concepts this produces.
async function extractAndCreateConcepts(
  chatbotId: string,
  text: string,
  provenance: { sourceDocumentId: string | null; resourceUrl?: string | null },
): Promise<{ created: OKFConcept[]; costUsd: number }> {
  const usage: AiUsage[] = []
  const raw = await completeCheaply(EXTRACTION_SYSTEM, extractionPrompt(text), usage, cheapCallAuthorizer(chatbotId))
  if (usage.length > 0) {
    await recordUsage(chatbotId, usage).catch(() => undefined)
  }
  const costUsd = usage.reduce(
    (sum, item) => sum + estimateCostUsd(item.model, item.inputTokens, item.outputTokens),
    0,
  )
  if (!raw) return { created: [], costUsd }

  const parsed = parseConcepts(raw)
  const created = await createSuggestedConcepts(
    chatbotId,
    parsed.map((item) => ({
      type: item.type,
      title: item.title,
      description: item.description,
      tags: item.tags,
      bodyMd: item.body_md,
      createdBy: "ai_extracted",
      sourceDocumentId: provenance.sourceDocumentId,
      resourceUrl: provenance.resourceUrl ?? null,
    })),
    provenance.sourceDocumentId,
  )
  return { created, costUsd }
}

export async function suggestOKFConcepts(documentId: string, chatbotId: string): Promise<number> {
  if (!pool) return 0
  const { rows: docs } = await pool.query<{ file_name: string; user_id: string }>(
    `select d.file_name, c.user_id
       from chatbot_documents d
       join chatbots c on c.id = d.chatbot_id
      where d.id = $1 and d.chatbot_id = $2`,
    [documentId, chatbotId],
  )
  if (!docs[0]) return 0

  const { rows: chunks } = await pool.query<{ content: string }>(
    `select content from chatbot_document_chunks
      where document_id = $1 and chatbot_id = $2
      order by created_at
      limit 20`,
    [documentId, chatbotId],
  )
  const text = chunks.map((row) => row.content).join("\n\n").trim()
  if (!text) return 0

  const { created, costUsd } = await extractAndCreateConcepts(chatbotId, text, { sourceDocumentId: documentId })

  await pool.query(
    `update document_ingestion_log
        set okf_suggestion_cost_usd = $2, okf_suggestion_count = $3
      where id = (select id from document_ingestion_log where document_id = $1 order by created_at desc limit 1)`,
    [documentId, costUsd || null, created.length],
  ).catch(() => undefined)

  if (created.length > 0) {
    await createNotification({
      userId: docs[0].user_id,
      type: "system",
      title: "OKF concepts suggested",
      body: `${created.length} OKF concept${created.length === 1 ? "" : "s"} suggested from ${docs[0].file_name} — review and approve.`,
      metadata: { chatbotId, documentId, count: created.length },
    }).catch(() => undefined)
  }

  log().info(
    { event: "okf.suggest_complete", chatbotId, documentId, count: created.length, costUsd },
    "okf suggestions written",
  )
  return created.length
}

// One crawled page, already past the relevance filter and the dedup check
// (see suggestOKFConceptsFromCrawledPages, the actual entry point called
// from the crawl/recrawl jobs). Exported separately so it stays testable in
// isolation from the filtering/ranking/capping logic around it.
export async function suggestOKFConceptsFromCrawlPage(
  chatbotId: string,
  userId: string,
  url: string,
  text: string,
): Promise<number> {
  const { created, costUsd } = await extractAndCreateConcepts(chatbotId, text, {
    sourceDocumentId: null,
    resourceUrl: url,
  })

  if (created.length > 0) {
    await createNotification({
      userId,
      type: "system",
      title: "OKF concepts suggested",
      body: `${created.length} OKF concept${created.length === 1 ? "" : "s"} suggested from ${url} — review and approve.`,
      metadata: { chatbotId, resourceUrl: url, count: created.length },
    }).catch(() => undefined)
  }

  log().info(
    { event: "okf.suggest_complete", chatbotId, resourceUrl: url, count: created.length, costUsd },
    "okf suggestions written from crawled page",
  )
  return created.length
}

// The actual crawl/recrawl entry point. Three guardrails, in order:
//   1. relevance filter (okfPageRelevance.ts) — skip boilerplate pages
//      (nav/footer/about/blog) without spending an LLM call on them
//   2. dedup — skip a page that already has a pending or approved concept
//      for its URL, so a trivial re-crawl doesn't spawn a second
//      suggestion next to one still sitting unreviewed
//   3. a hard cap on how many pages get sent to the LLM per crawl run, so
//      a large site can't dump dozens of pending concepts on the owner at
//      once — the highest-scoring (most relevance signals matched) pages
//      go first
export async function suggestOKFConceptsFromCrawledPages(
  chatbotId: string,
  pages: { url: string; content: string }[],
): Promise<void> {
  if (!pool || !env.okfCrawlSuggestEnabled || pages.length === 0) return

  const candidates = pages
    .filter((page) => page.content && page.content.trim().length > 0)
    .map((page) => ({ ...page, score: scoreOkfRelevance(page.url, page.content) }))
    .filter((page) => page.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, env.okfCrawlSuggestMaxPagesPerRun)

  if (candidates.length === 0) return

  const { rows } = await pool.query<{ user_id: string }>("select user_id from chatbots where id = $1", [chatbotId])
  const userId = rows[0]?.user_id
  if (!userId) return

  for (const page of candidates) {
    try {
      const { rows: existing } = await pool.query<{ id: string }>(
        "select id from okf_concepts where chatbot_id = $1 and resource_url = $2 and is_active = true limit 1",
        [chatbotId, page.url],
      )
      if (existing[0]) {
        log().info({ event: "okf.suggest_skipped_duplicate", chatbotId, resourceUrl: page.url }, "okf suggestion skipped — concept already exists for this URL")
        continue
      }
      await suggestOKFConceptsFromCrawlPage(chatbotId, userId, page.url, page.content)
    } catch (err) {
      log().warn(
        { event: "okf.suggest_from_crawl_failed", chatbotId, resourceUrl: page.url, err: err instanceof Error ? err.message : String(err) },
        "okf suggestion from crawled page failed",
      )
    }
  }
}

// Re-exported for direct unit testing of the filter in isolation.
export { isLikelyOkfRelevantPage }
