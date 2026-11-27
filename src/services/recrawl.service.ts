import { bumpChatbotCacheVersion } from "../lib/cache.js"
import type { ChatbotSource } from "../lib/chatbot.js"
import { pool } from "../lib/db.js"
import { AppError } from "../lib/errors.js"
import { log } from "../lib/logger.js"
import { checkAnsweringGate, isUsageGateReason } from "./accessGate.service.js"
import { crawlWebsiteForChatbot } from "./chatbot.service.js"
import { suggestOKFConceptsFromCrawledPages } from "./okfSuggestion.service.js"

export interface RecrawlOutcome {
  chatbotId: string
  skipped: boolean
  reason?: string
  pagesChecked: number
  pagesChanged: number
  pagesSkipped: number
}

function skip(chatbotId: string, reason: string): RecrawlOutcome {
  return { chatbotId, skipped: true, reason, pagesChecked: 0, pagesChanged: 0, pagesSkipped: 0 }
}


export async function runIncrementalRecrawl(chatbotId: string): Promise<RecrawlOutcome> {
  if (!pool) return skip(chatbotId, "no-database")

  const { rows } = await pool.query<{ website_url: string | null; sources: unknown }>(
    "select website_url, sources from chatbots where id = $1",
    [chatbotId],
  )
  const row = rows[0]
  if (!row) return skip(chatbotId, "chatbot-not-found")
  if (!row.website_url) return skip(chatbotId, "no-website-url")

 
  const gate = await checkAnsweringGate(chatbotId)
  if (gate.blocked && !isUsageGateReason(gate.reason)) {
    log().info({ chatbotId, gateReason: gate.reason }, "incremental recrawl skipped — chatbot gated")
    return skip(chatbotId, gate.reason ?? "gated")
  }

  const existingSources: ChatbotSource[] = Array.isArray(row.sources) ? (row.sources as ChatbotSource[]) : []
  const existingByUrl = new Map(
    existingSources.filter((s) => s.type === "website" && s.url).map((s) => [s.url as string, s]),
  )
  const nonWebsiteSources = existingSources.filter((s) => s.type !== "website")

  let crawlResult: Awaited<ReturnType<typeof crawlWebsiteForChatbot>>
  try {
    crawlResult = await crawlWebsiteForChatbot(row.website_url)
  } catch (err) {
    const reason = err instanceof AppError ? err.message : "crawl-failed"
    log().warn({ chatbotId, reason }, "incremental recrawl's crawl attempt failed")
    return skip(chatbotId, reason)
  }


  let pagesChanged = 0
  let pagesSkipped = 0
  // Reuses the same "did this page's content actually change" comparison
  // the recrawl diff already needs — a page whose hash didn't move is never
  // reconsidered for OKF, with no separate bookkeeping to keep in sync.
  const changedPages: { url: string; content: string }[] = []
  const nextWebsiteSources: ChatbotSource[] = crawlResult.sources.map((freshSource) => {
    const existing = freshSource.url ? existingByUrl.get(freshSource.url) : undefined
    if (existing && freshSource.contentHash && existing.contentHash === freshSource.contentHash) {
      pagesSkipped++
      return existing
    }
    pagesChanged++
    if (freshSource.url && freshSource.content) {
      changedPages.push({ url: freshSource.url, content: freshSource.content })
    }
    return freshSource
  })

  const pagesChecked = nextWebsiteSources.length

  if (pagesChanged > 0) {
    const sources = [...nonWebsiteSources, ...nextWebsiteSources]
    await pool.query("update chatbots set sources = $1 where id = $2", [JSON.stringify(sources), chatbotId])

    await bumpChatbotCacheVersion(chatbotId)

    // Awaited, not fire-and-forget: this runs inside the recrawl worker job,
    // not a request path, so there's no latency reason to detach it — and
    // detaching it would let the job report "completed" while OKF work is
    // still in flight. suggestOKFConceptsFromCrawledPages already catches
    // per-page errors internally; this try/catch is just the backstop that
    // must never fail the recrawl job itself.
    try {
      await suggestOKFConceptsFromCrawledPages(chatbotId, changedPages)
    } catch (err) {
      log().warn(
        { event: "okf.suggest_from_recrawl_failed", chatbotId, err: err instanceof Error ? err.message : String(err) },
        "okf suggestion pass after recrawl failed",
      )
    }
  }

  log().info({ chatbotId, pagesChecked, pagesChanged, pagesSkipped }, "incremental recrawl completed")
  return { chatbotId, skipped: false, pagesChecked, pagesChanged, pagesSkipped }
}


export async function listRecrawlCandidateChatbotIds(): Promise<string[]> {
  if (!pool) return []
  const { rows } = await pool.query<{ id: string }>("select id from chatbots where website_url is not null")
  return rows.map((r) => r.id)
}
