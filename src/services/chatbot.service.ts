import { answerChatbotQuestion } from "../lib/answerChatbotQuestion.js"
import { verifyAccessToken } from "../lib/auth.js"
import { bumpChatbotCacheVersion } from "../lib/cache.js"
import { requireOwnedChatbotId } from "../lib/chatbotOwnership.js"
import { chatbotRowToChatbot, DEFAULT_THEME, defaultFallbackMessage, hashPageContent, type ChatbotSource } from "../lib/chatbot.js"
import { crawlWebsite } from "../lib/crawler/crawl.js"
import { pool } from "../lib/db.js"
import { AppError } from "../lib/errors.js"
import { log } from "../lib/logger.js"
import { enqueueCrawlJob } from "../lib/queue.js"
import { currentRequestId } from "../lib/requestContext.js"
import { getAccountStatus, type AccountStatus } from "./accessGate.service.js"
import { getEntitlementForUser } from "./billing.service.js"
import { loadConversationContext, recordTurn } from "./conversation.service.js"
import { chatSessionKey } from "./customerSession.service.js"
import { resolveTenantContext } from "../lib/tenancy.js"
import { getLiveDataForAnswering } from "./liveData.service.js"
import { suggestOKFConceptsFromCrawledPages } from "./okfSuggestion.service.js"
import { requireFullCustomPlan } from "./commerceCredentials.service.js"
import { tryAnswerWithCommerceGraph } from "../langgraph/commerceEntrypoint.js"
import { tryAnswerWithBooklyGraph } from "../langgraph/booklyEntrypoint.js"
import type {
  ChatInput,
  CreateChatbotInput,
  RetryChatbotInput,
  UpdateDomainInput,
  UpdateFallbackMessageInput,
  UpdatePreferredModelInput,
  UpdateThemeInput,
} from "../validators/chatbot.validator.js"

const CHATBOT_COLUMNS = "id, name, sources, theme, allowed_domain, created_at, status, status_reason, fallback_message, preferred_model, website_url"


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

function normalizeUrl(value: string) {
  const url = new URL(value)
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new AppError(400, "Enter a valid http or https website URL.")
  }
  url.hash = ""
  return url
}


async function setCrawlStatus(chatbotId: string, status: string, statusReason?: string) {
  const db = requireDbPool()
  await db.query("update chatbots set status = $1, status_reason = $2 where id = $3", [
    status,
    statusReason ?? null,
    chatbotId,
  ])
  log().info({ chatbotId, status, statusReason }, "crawl job state transition")
}


export async function runCrawlJob(chatbotId: string, url: string): Promise<void> {
  const db = requireDbPool()

  await setCrawlStatus(chatbotId, "crawling")

  const { rows } = await db.query<{ sources: unknown }>("select sources from chatbots where id = $1", [chatbotId])
  if (!rows[0]) return // chatbot was deleted/recreated since the job was enqueued — nothing to do

  const fileSources: ChatbotSource[] = (
    Array.isArray(rows[0].sources) ? (rows[0].sources as ChatbotSource[]) : []
  ).filter((source) => source.type !== "website")

  try {
    const result = await crawlWebsiteForChatbot(url)

    await setCrawlStatus(chatbotId, "processing")

    const sources = [...fileSources, ...result.sources]
    await db.query("update chatbots set sources = $1, name = $2, status = 'ready', status_reason = null where id = $3", [
      JSON.stringify(sources),
      result.siteName,
      chatbotId,
    ])
    log().info({ chatbotId, status: "ready", pagesFound: result.sources.length }, "crawl job state transition")

    await bumpChatbotCacheVersion(chatbotId)

    // First-time crawl: every page is "new" by definition, so unlike
    // runIncrementalRecrawl there's no content-hash diff to gate on here —
    // the relevance filter and per-run cap inside
    // suggestOKFConceptsFromCrawledPages still apply. Awaited so this job
    // doesn't report done while OKF extraction is still in flight; its own
    // try/catch there is the backstop that keeps a failure here from
    // failing the crawl job.
    try {
      const candidatePages = result.sources
        .filter((source): source is ChatbotSource & { url: string; content: string } => Boolean(source.url && source.content))
        .map((source) => ({ url: source.url, content: source.content }))
      await suggestOKFConceptsFromCrawledPages(chatbotId, candidatePages)
    } catch (err) {
      log().warn(
        { event: "okf.suggest_from_initial_crawl_failed", chatbotId, err: err instanceof Error ? err.message : String(err) },
        "okf suggestion pass after initial crawl failed",
      )
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Crawl failed. Try again."
    await setCrawlStatus(chatbotId, "failed", message)
    throw err
  }
}

export async function crawlWebsiteForChatbot(url: string) {
  const target = normalizeUrl(url)

  let result: Awaited<ReturnType<typeof crawlWebsite>>
  try {
    result = await crawlWebsite(target.toString())
  } catch (err) {
    throw new AppError(
      422,
      err instanceof Error && err.message.includes("blocked")
        ? "That URL can't be crawled (blocked or unreachable address)."
        : "Couldn't reach that website. Check the URL and try again.",
    )
  }

  if (result.pages.length === 0) {
    throw new AppError(422, "Couldn't find any readable content on that site.")
  }

  const sources: ChatbotSource[] = result.pages.map((page) => {
    const url = new URL(page.path, target)
    return {
      type: "website",
      label: `${url.hostname.replace(/^www\./, "")}${url.pathname === "/" ? "" : url.pathname}`,
      url: url.toString(),
      characters: page.text.length,
      content: page.text,
      contentHash: hashPageContent(page.text),
    }
  })

  return {
    siteName: result.siteTitle,
    sources,
    pagesFound: result.pages.length,
  }
}


export async function createChatbot(accessToken: string, input: CreateChatbotInput) {
  const db = requireDbPool()
  const actorUserId = requireUserId(accessToken)
  const { tenantUserId } = await resolveTenantContext(actorUserId, "admin")

  const { rows: verifyRows } = await db.query<{ email_verified: boolean }>(
    "select email_verified from users where id = $1",
    [tenantUserId],
  )
  if (verifyRows[0] && !verifyRows[0].email_verified) {
    throw new AppError(403, "Verify your email before creating a chatbot. Check your inbox or resend the link from Settings.")
  }

  const entitlement = await getEntitlementForUser(tenantUserId)
  const { rows: countRows } = await db.query<{ count: string }>(
    "select count(*)::text as count from chatbots where user_id = $1",
    [tenantUserId],
  )
  const existingCount = Number(countRows[0].count)

  if (existingCount >= entitlement.maxChatbots) {
    
    if (!entitlement.active) {
      throw new AppError(
        409,
        `Your ${entitlement.plan === "free" ? "free trial" : "plan"} includes ${entitlement.maxChatbots} chatbot${entitlement.maxChatbots === 1 ? "" : "s"}. Upgrade your plan to create more.`,
      )
    }
    throw new AppError(409, `You've reached your plan's limit of ${entitlement.maxChatbots} chatbots.`)
  }

  const theme = input.theme || DEFAULT_THEME
  const status = input.websiteUrl ? "queued" : "ready"
  // A chatbot created against a website URL is meant to work on that site
  // immediately, with no separate manual step — the domain typed at
  // onboarding IS the one it should be allowed to embed on. Input already
  // passed the schema's z.string().url() check, so this can't throw.
  const initialAllowedDomain = input.websiteUrl ? new URL(input.websiteUrl).hostname.toLowerCase() : null

  const row = (
    await db.query(
      `insert into chatbots (user_id, name, sources, theme, status, website_url, allowed_domain)
       values ($1, $2, $3, $4, $5, $6, $7)
       returning ${CHATBOT_COLUMNS}`,
      [tenantUserId, input.name, JSON.stringify(input.sources), JSON.stringify(theme), status, input.websiteUrl || null, initialAllowedDomain],
    )
  ).rows[0]

  if (input.websiteUrl) {
    await enqueueCrawlJob({ chatbotId: row.id, url: input.websiteUrl, requestId: currentRequestId() })
  }

  return chatbotRowToChatbot(row)
}


// account can own more than one.
export async function retryChatbotCrawl(accessToken: string, chatbotId: string, input: RetryChatbotInput) {
  const db = requireDbPool()
  const actorUserId = requireUserId(accessToken)
  const { tenantUserId } = await resolveTenantContext(actorUserId, "admin")
  const ownedId = await requireOwnedChatbotId(tenantUserId, chatbotId)

  const { rows: existing } = await db.query<{ status: string }>("select status from chatbots where id = $1", [ownedId])
  if (existing[0]?.status !== "failed") {
    throw new AppError(400, "Only a chatbot whose crawl failed can be retried.")
  }

  const row = (
    await db.query(
      `update chatbots set status = 'queued', status_reason = null, website_url = $1
       where id = $2 returning ${CHATBOT_COLUMNS}`,
      [input.websiteUrl, ownedId],
    )
  ).rows[0]

  await enqueueCrawlJob({ chatbotId: ownedId, url: input.websiteUrl, requestId: currentRequestId() })
  return chatbotRowToChatbot(row)
}

export interface ChatbotListEntry {
  chatbot: ReturnType<typeof chatbotRowToChatbot>
  account: AccountStatus
}


export async function listChatbots(accessToken: string): Promise<ChatbotListEntry[]> {
  const db = requireDbPool()
  const actorUserId = requireUserId(accessToken)
  const { tenantUserId } = await resolveTenantContext(actorUserId, "viewer")

  const { rows } = await db.query(`select ${CHATBOT_COLUMNS} from chatbots where user_id = $1 order by created_at asc`, [tenantUserId])
  return Promise.all(
    rows.map(async (row) => {
      const chatbot = chatbotRowToChatbot(row)
      const account = await getAccountStatus(tenantUserId, chatbot.id)
      return { chatbot, account }
    }),
  )
}


export async function getChatbotById(accessToken: string, chatbotId: string): Promise<ChatbotListEntry> {
  const db = requireDbPool()
  const actorUserId = requireUserId(accessToken)
  const { tenantUserId } = await resolveTenantContext(actorUserId, "viewer")
  const ownedId = await requireOwnedChatbotId(tenantUserId, chatbotId)

  const { rows } = await db.query(`select ${CHATBOT_COLUMNS} from chatbots where id = $1`, [ownedId])
  const chatbot = chatbotRowToChatbot(rows[0])
  const account = await getAccountStatus(tenantUserId, chatbot.id)
  return { chatbot, account }
}


async function updateOwnedChatbot(
  accessToken: string,
  chatbotId: string,
  column: "theme" | "allowed_domain" | "fallback_message" | "preferred_model",
  value: unknown,
) {
  const db = requireDbPool()
  const actorUserId = requireUserId(accessToken)
  const { tenantUserId } = await resolveTenantContext(actorUserId, "admin")
  const ownedId = await requireOwnedChatbotId(tenantUserId, chatbotId)

  const { rows } = await db.query(
    `update chatbots set ${column} = $1 where id = $2
     returning ${CHATBOT_COLUMNS}`,
    [value, ownedId],
  )
  return chatbotRowToChatbot(rows[0])
}

export async function updateChatbotTheme(accessToken: string, chatbotId: string, input: UpdateThemeInput) {
  return updateOwnedChatbot(accessToken, chatbotId, "theme", JSON.stringify(input.theme))
}

export async function updateChatbotFallbackMessage(accessToken: string, chatbotId: string, input: UpdateFallbackMessageInput) {
  return updateOwnedChatbot(accessToken, chatbotId, "fallback_message", input.fallbackMessage)
}


export async function updateChatbotPreferredModel(accessToken: string, chatbotId: string, input: UpdatePreferredModelInput) {
  const actorUserId = requireUserId(accessToken)
  const { tenantUserId } = await resolveTenantContext(actorUserId, "admin")
  const ownedId = await requireOwnedChatbotId(tenantUserId, chatbotId)
  await requireFullCustomPlan(ownedId)

  const value = input.preferredModel === "auto" ? null : input.preferredModel
  const chatbot = await updateOwnedChatbot(accessToken, chatbotId, "preferred_model", value)
  log().info({ chatbotId: ownedId, preferredModel: value, event: "preferred-model-changed" }, "chatbot preferred model changed")
  return chatbot
}

function normalizeDomain(value: string): string {
  const trimmed = value.trim().toLowerCase()
  if (trimmed.includes("//")) {
    try {
      return new URL(trimmed).hostname
    } catch {
      throw new AppError(400, "Enter a valid domain, like example.com.")
    }
  }
  const bare = trimmed.split("/")[0]
  if (!bare) throw new AppError(400, "Enter a valid domain, like example.com.")
  return bare
}

export async function updateChatbotDomain(accessToken: string, chatbotId: string, input: UpdateDomainInput) {
  return updateOwnedChatbot(accessToken, chatbotId, "allowed_domain", normalizeDomain(input.domain))
}


export async function chatWithOwnChatbot(accessToken: string, chatbotId: string, input: ChatInput) {
  const db = requireDbPool()
  const actorUserId = requireUserId(accessToken)
  const { tenantUserId } = await resolveTenantContext(actorUserId, "admin")
  const ownedId = await requireOwnedChatbotId(tenantUserId, chatbotId)

  const { rows } = await db.query(`select ${CHATBOT_COLUMNS} from chatbots where id = $1`, [ownedId])
  const chatbot = chatbotRowToChatbot(rows[0])


  // CS-04: preview sessions are namespaced by the owner's user id and never
  // share a conversation or graph thread with a widget visitor.
  const previewKey = input.sessionId ? chatSessionKey("preview", actorUserId, input.sessionId) : null
  const commerceResult = await tryAnswerWithCommerceGraph(chatbot.id, previewKey, input.question, currentRequestId())
  if (commerceResult.handled) {
    return { text: commerceResult.text ?? "", aiGenerated: true, gateReason: commerceResult.gateReason, retryAfterSeconds: commerceResult.retryAfterSeconds, products: commerceResult.products }
  }

 
  const booklyResult = await tryAnswerWithBooklyGraph(chatbot.id, previewKey, input.question, currentRequestId())
  if (booklyResult.handled) {
    return { text: booklyResult.text ?? "", aiGenerated: true, gateReason: booklyResult.gateReason, retryAfterSeconds: booklyResult.retryAfterSeconds }
  }

  const liveData = await getLiveDataForAnswering(chatbot.id)

  let effectiveHistory = input.history
  let conversation: { conversationId: string; pinnedModel: string | null } | undefined
  if (previewKey) {
    const context = await loadConversationContext(chatbot.id, previewKey)
    effectiveHistory = context.history
    conversation = { conversationId: context.conversationId, pinnedModel: context.pinnedModel }
  }

  const answer = await answerChatbotQuestion(
    chatbot.id,
    chatbot.name,
    chatbot.sources,
    input.question,
    effectiveHistory,
    chatbot.fallbackMessage || defaultFallbackMessage(chatbot.name),
    liveData,
    conversation,
    chatbot.preferredModel,
  )

  if (conversation && !answer.gateReason) {
    await recordTurn(conversation.conversationId, input.question, answer.text)
  }

  return answer
}
