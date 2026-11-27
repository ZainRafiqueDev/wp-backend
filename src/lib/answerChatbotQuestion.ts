import type { ActionToolDef, ChatbotAction, ToolExecutor } from "./actions.js"
import { executeAction, validateActionParams } from "./actionExecutor.js"
import { answerFromSources } from "./answerFromSources.js"
import { answerQuestion, type AiUsage, type ProviderKey } from "./ai.js"
import { fetchBackendLiveContext } from "./backendLink.js"
import {
  cacheKey,
  getCached,
  getChatbotCacheVersion,
  incrementCacheMetric,
  normalizeQuestionKey,
  setCached,
} from "./cache.js"
import { defaultFallbackMessage, type ChatbotSource } from "./chatbot.js"
import type { CrawledPage } from "./crawler/crawl.js"
import { env } from "../env.js"
import { verifyGroundedClaims } from "./groundingCheck.js"
import { estimateReservationUsd } from "./aiPricing.js"
import { chatMessageDebugField, chatMessageSummary, log } from "./logger.js"
import type { ModelKey } from "./plans.js"
import { currentRequestId } from "./requestContext.js"
import { formatFactsForPrompt } from "./memoryFacts.js"
import { hasRelevantContent, rankPagesByRelevance } from "./relevance.js"
import { rewriteQueryForRetrieval } from "./queryRewrite.js"
import { getActionsForAnswering } from "../services/actions.service.js"
import { recordCacheMissAndCheckAbuse } from "../services/abuseDetection.service.js"
import { checkAnsweringGate, visitorMessageForGate, type GateReason } from "../services/accessGate.service.js"
import { getEntitlementForChatbot } from "../services/billing.service.js"
import { listRecentAttachmentFilenames, pinModelIfUnset } from "../services/conversation.service.js"
import { getDecryptedApiKeyForChatbot } from "../services/integration.service.js"
import { lookupRelevantDocumentChunks } from "../services/documentIngestion.service.js"
import { selectModelForConversation } from "../services/modelSelection.service.js"
import { routeQuery } from "../services/okfRouter.service.js"
import { recordRoutingEvent } from "../services/routingEvents.service.js"
import { saveInterruptedByCreditExhaustion } from "../services/sessionMemory.service.js"
import { getCostCapBlock, recordUsage, reserveModelCostSlot } from "../services/usage.service.js"

interface ChatMessage {
  role: "user" | "assistant"
  content: string
}

export interface LiveDataInput {
  key: string
  value: string
}

export interface ChatbotAnswer {
  text: string
  source?: string
  aiGenerated: boolean

  gateReason?: GateReason
  retryAfterSeconds?: number
}

// Cross-session memory for a customer the caller has already resolved to a
// stable identity (e.g. via OTP email verification) — see
// sessionMemory.service.ts. `identifier` is the hashed, chatbot-scoped key
// used to persist/update session_summaries; absent entirely for anonymous
// visitors, who get no cross-visit memory (there's nothing stable to key it
// on).
export interface CustomerMemoryContext {
  identifier: string
  summaryMd: string | null
  interruptedByCreditExhaustion: boolean
  // WP-3.4: durable structured facts (conversation_facts), shown alongside the
  // prose summary. Empty for a customer nothing has been extracted for yet.
  facts?: { key: string; value: string }[]
}


export function sourcesToPages(sources: ChatbotSource[]): CrawledPage[] {
  return sources
    .filter((s): s is ChatbotSource & { content: string } => Boolean(s.content))
    .map((s) => ({ path: s.url || s.label, title: s.label, text: s.content, kind: "crawled" as const }))
}


export function liveDataToPages(liveData: LiveDataInput[]): CrawledPage[] {
  return liveData.map((entry) => ({ path: `live:${entry.key}`, title: entry.key, text: entry.value, kind: "live" as const }))
}


export function mergePages(liveData: LiveDataInput[], sources: ChatbotSource[]): CrawledPage[] {
  return [...liveDataToPages(liveData), ...sourcesToPages(sources)]
}

function contextTextFor(pages: CrawledPage[]): string {
  return pages.map((p) => p.text).join("\n")
}

const CONTEXTUAL_REFERENCE = /\b(it|its|that|this|they|them|those|these|there|one|ones|same)\b/i
const CONTEXTUAL_FRAGMENT = /^(?:what|how) about\b|^(?:price|cost|details|more)\??$/i

export function buildRetrievalQuery(question: string, history: ChatMessage[]): string {
  if (!CONTEXTUAL_REFERENCE.test(question) && !CONTEXTUAL_FRAGMENT.test(question.trim())) return question

  const priorContext = history
    .slice(-4)
    .map((message) => `${message.role}: ${message.content.trim().slice(0, 500)}`)
    .filter(Boolean)

  return priorContext.length > 0
    ? `${priorContext.join("\n")}\nFollow-up: ${question}`
    : question
}

/**
 * WP-3.4: the memory half of the retrieval context — the prose summary and the
 * structured facts, as two separate pages so truncation drops the (longer,
 * lower-signal) summary before it drops the facts.
 */
export function buildMemoryPages(memory: CustomerMemoryContext | null | undefined): CrawledPage[] {
  if (!memory) return []
  const pages: CrawledPage[] = []

  const facts = memory.facts ?? []
  if (facts.length > 0) {
    pages.push({
      path: "memory:customer-facts",
      title: "Known facts about this customer",
      text: `${formatFactsForPrompt(facts)}\n\n[These were established in earlier conversations. Use them when relevant; do not re-ask for them. Never state one back as new information.]`,
      kind: "memory",
    })
  }

  if (memory.summaryMd) {
    pages.push({
      path: "memory:customer-summary",
      title: "Previous conversation",
      text: memory.interruptedByCreditExhaustion
        ? `${memory.summaryMd}\n\n[Note: the previous conversation was cut short because the chatbot ran out of AI credits before it could respond. Acknowledge this naturally, then continue helping.]`
        : memory.summaryMd,
      kind: "memory",
    })
  }

  return pages
}

// Phase 3 follow-up: a conversation that has an accepted attachment always
// gets this reminder, regardless of retrieval relevance — the risk it
// guards against (the model inferring/guessing file contents from the
// filename when later asked "what's in it?") isn't a retrieval problem, so
// it can't be left to rankPagesByRelevance to decide whether it's "relevant
// enough" to include.
export function buildAttachmentNoticePages(fileNames: string[]): CrawledPage[] {
  if (fileNames.length === 0) return []
  const plural = fileNames.length > 1
  const list = fileNames.join(", ")
  return [
    {
      path: "attachment:notice",
      title: "Visitor-uploaded file",
      text:
        `The visitor attached ${plural ? "these files" : "a file"}: ${list}. ` +
        `You cannot see ${plural ? "their" : "its"} contents; say the team will review ${plural ? "them" : "it"}.\n\n` +
        `[Never claim to have read, viewed, opened, or looked at the file. If asked what's in it, repeat that the team will review it — do not guess from the filename.]`,
      kind: "attachment",
    },
  ]
}

export function estimateAnswerInputTokens(
  pages: CrawledPage[],
  history: ChatMessage[],
  question: string,
  tools: ActionToolDef[],
): number {
  const pageChars = Math.min(100_000, contextTextFor(pages).length)
  const historyChars = history.reduce((total, message) => total + message.content.length, 0)
  const toolChars = tools.reduce(
    (total, tool) => total + tool.name.length + tool.description.length + JSON.stringify(tool.parameters).length,
    0,
  )
  // 2.5 chars/token is deliberately conservative for mixed prose/JSON.
  return Math.ceil((pageChars + historyChars + question.length + toolChars + 4_000) / 2.5)
}

function buildActionToolDefs(actions: ChatbotAction[]): ActionToolDef[] {
  return actions.map((a) => ({ name: a.name, description: a.description, parameters: a.parameters }))
}


function actionRelevancePages(tools: ActionToolDef[]): CrawledPage[] {
  return tools.map((tool) => ({
    path: `action:${tool.name}`,
    title: tool.name,
    text: `${tool.description} ${tool.parameters.map((p) => p.description).join(" ")}`,
  }))
}


function buildActionExecutor(actions: ChatbotAction[], chatbotId: string): ToolExecutor {
  const byName = new Map(actions.map((a) => [a.name, a]))
  return async (name, args) => {
    const action = byName.get(name)
    if (!action) return { content: "This action is currently unavailable.", isError: true }

    const validated = validateActionParams(action, args)
    if (!validated.ok) {
      return { content: `This action is currently unavailable (${validated.error})`, isError: true }
    }

    const apiKey = await getDecryptedApiKeyForChatbot(chatbotId)
    return executeAction(action, validated.values, apiKey)
  }
}


async function sourcesToPagesCached(chatbotId: string, cacheVersion: number, sources: ChatbotSource[]): Promise<CrawledPage[]> {
  const key = cacheKey(chatbotId, "pages", String(cacheVersion))
  const cached = await getCached<CrawledPage[]>(key)
  if (cached) return cached

  const pages = sourcesToPages(sources)
  await setCached(key, pages, env.pagesCacheTtlSeconds)
  return pages
}


export async function answerChatbotQuestion(
  chatbotId: string,
  chatbotName: string,
  sources: ChatbotSource[],
  question: string,
  history: ChatMessage[],
  fallbackMessage: string = defaultFallbackMessage(chatbotName),
  liveData: LiveDataInput[] = [],
  
  conversation?: { conversationId: string; pinnedModel: string | null },

  preferredModel?: "anthropic" | "openai" | "gemini" | null,
  customerMemory?: CustomerMemoryContext | null,
): Promise<ChatbotAnswer> {
  
  const gate = await checkAnsweringGate(chatbotId)
  if (gate.blocked) {
    log().info({ chatbotId, gateReason: gate.reason }, "chatbot answering gate blocked this request")
    // Save-before-block (master prompt, non-negotiable): persist the
    // unanswered question against this customer's cross-session summary
    // before returning the block, so the next session (post top-up) can
    // resume with context instead of starting cold. No-op for anonymous
    // visitors (no stable identifier to key it on).
    if (gate.reason === "monthly_credits_exhausted" && customerMemory?.identifier) {
      await saveInterruptedByCreditExhaustion(chatbotId, customerMemory.identifier, question)
    }
    return {
      text: visitorMessageForGate(gate.reason, fallbackMessage),
      aiGenerated: false,
      gateReason: gate.reason,
      retryAfterSeconds: gate.retryAfterSeconds,
    }
  }

  const entitlement = await getEntitlementForChatbot(chatbotId)
  // WP-3.1: an LLM-rewritten, standalone search query when there's history
  // to resolve against (falls back to the free regex heuristic below on any
  // failure/timeout/no-provider-configured — never blocks the request).
  // Retrieval-only: `question` itself, unmodified, is still what goes to
  // the answering LLM and what gets shown/recorded anywhere.
  const rewrittenQuery = await rewriteQueryForRetrieval(chatbotId, question, history)
  const retrievalQuery = rewrittenQuery ?? buildRetrievalQuery(question, history)

  const okfResult = await routeQuery(chatbotId, retrievalQuery)
  if (okfResult.matched && okfResult.answer) {
    log().info(
      {
        event: "okf.answer",
        chatbotId,
        conceptId: okfResult.concept?.id,
        routingMethod: okfResult.routingMethod,
        confidence: okfResult.confidence,
      },
      "okf answered without LLM paraphrase",
    )
    return {
      text: okfResult.answer,
      source: okfResult.citationUrl || okfResult.concept?.title,
      aiGenerated: false,
    }
  }

  const cacheVersion = await getChatbotCacheVersion(chatbotId)
  const crawledPages = await sourcesToPagesCached(chatbotId, cacheVersion, sources)

  const backendPages = await fetchBackendLiveContext(chatbotId, cacheVersion)
  // Only paid plans have document ingestion at all (enforced at upload
  // time in documentIngestion.service.ts) — skip the lookup entirely for
  // free-plan chatbots rather than spend an embedding call finding zero
  // rows every single question.
  // WP-2.3: paid plans get fused lexical+vector document chunks (still
  // chatbot_id scoped). RETRIEVAL_MODE=vector rolls back to HNSW only.
  const documentPages = entitlement.documentIngestion.enabled
    ? await lookupRelevantDocumentChunks(chatbotId, retrievalQuery)
    : []
  // Put synonym/token matches first so maxChars truncation keeps the pages
  // that actually support the question (e.g. /web-development for "web dev").
  const rankedCrawled = rankPagesByRelevance(retrievalQuery, crawledPages)
  const memoryPages = buildMemoryPages(customerMemory)
  // Same plan gate as documentPages above: attachments don't exist at all
  // on a plan where chatAttachments is disabled, so skip the query entirely
  // rather than ask every question whether this conversation has any.
  const attachmentFileNames =
    entitlement.chatAttachments.enabled && conversation?.conversationId
      ? await listRecentAttachmentFilenames(conversation.conversationId)
      : []
  const attachmentPages = buildAttachmentNoticePages(attachmentFileNames)
  const pages = [...attachmentPages, ...memoryPages, ...liveDataToPages(liveData), ...backendPages, ...rankedCrawled, ...documentPages]

  
  const actionAccess = await getActionsForAnswering(chatbotId)
  const actions = actionAccess.actions
  const tools = buildActionToolDefs(actions)
  const executeTool = tools.length > 0 ? buildActionExecutor(actions, chatbotId) : undefined

  if (pages.length === 0 && tools.length === 0) {
    const fallback = answerFromSources(question, sources, fallbackMessage)
    return { ...fallback, aiGenerated: false }
  }

  // Contextual follow-ups must not share a cached answer across visitors.
  const questionKey = normalizeQuestionKey(retrievalQuery)
  const actionRelevant = tools.length > 0 && hasRelevantContent(retrievalQuery, actionRelevancePages(tools))
  const hasLiveContext = liveData.length > 0 || backendPages.length > 0
  // A conversation with attachments must never read or write the shared
  // answer cache: the cache key has no conversationId, so another visitor
  // asking the same question text could otherwise be served this visitor's
  // attachment notice (or vice versa).
  // CS-06 (VER-04): the answer and relevance caches are shared by every
  // visitor of this chatbot and keyed only by question text, so they may
  // only ever hold results produced without customer-specific context. A
  // resolved customer identity (memory summary/facts land in the prompt) or
  // any prior conversation turn (sent to the model and used for query
  // rewriting) bypasses both, read and write.
  const personalisedContext = Boolean(customerMemory) || memoryPages.length > 0 || history.length > 0
  const bypassAnswerCache =
    actionRelevant || hasLiveContext || attachmentFileNames.length > 0 || personalisedContext
  const bypassRelevanceCache = tools.length > 0 || personalisedContext
  const answerCacheKey = cacheKey(chatbotId, "answer", `${cacheVersion}:${questionKey}`)

  // Live catalog/stock and action results must never be served from the
  // static answer cache (WP-1.6). Pages/relevance keys stay tenant-prefixed.
  if (actionRelevant) {
    await incrementCacheMetric("cache.answer_bypass_tools", { chatbotId, reason: "tools" })
  }
  if (!bypassAnswerCache) {
    await incrementCacheMetric("cache.answer_read", { chatbotId })
    const cached = await getCached<ChatbotAnswer>(answerCacheKey)
    if (cached) {
      await incrementCacheMetric("cache.answer_hit", { chatbotId })
      log().info({ chatbotId, ...chatMessageSummary(question), cacheEvent: "answer-hit" }, "served cached answer")
      log().debug({ chatbotId, ...chatMessageDebugField(question) }, "cached answer question detail")
      return cached
    }
    await incrementCacheMetric("cache.answer_miss", { chatbotId })
    // Only a genuine miss on a cache-eligible request counts towards the
    // abuse window: a request that bypasses the cache (personalised, tools,
    // live data, attachments) could never have been a hit, so counting it
    // would flag busy chatbots with normal multi-turn traffic.
    await recordCacheMissAndCheckAbuse(chatbotId, question)
  }

  
  const relevanceCacheKey = cacheKey(chatbotId, "relevance", `${cacheVersion}:${questionKey}`)
  let relevant = bypassRelevanceCache ? null : await getCached<boolean>(relevanceCacheKey)
  if (relevant === null) {
    relevant = hasRelevantContent(retrievalQuery, [...pages, ...actionRelevancePages(tools)])
    if (!bypassRelevanceCache) {
      await setCached(relevanceCacheKey, relevant, env.relevanceCacheTtlSeconds)
    }
  }

  if (!relevant) {
    return { text: fallbackMessage, aiGenerated: false }
  }

 
  let preferredProvider: ProviderKey | undefined
  const allowedModels = actionRelevant ? actionAccess.eligibleModels : entitlement.allowedModels
  if (actionRelevant) {
    const requested = (conversation?.pinnedModel || preferredModel) as ModelKey | null | undefined
    preferredProvider = requested && allowedModels.includes(requested)
      ? requested
      : env.modelPriorityOrder.find((model) => allowedModels.includes(model as ModelKey)) as ModelKey | undefined
    if (preferredProvider && conversation?.conversationId) {
      await pinModelIfUnset(conversation.conversationId, preferredProvider)
    }
  } else if (conversation?.pinnedModel) {
    preferredProvider = conversation.pinnedModel as ProviderKey
  } else {
    const selection = await selectModelForConversation(chatbotId, preferredModel)
    if (selection) {
      preferredProvider = selection.provider
      if (conversation?.conversationId) {
        await pinModelIfUnset(conversation.conversationId, selection.provider)
      }
    }
  }

  // One requestId per logical question — each provider attempt inside
  // answerQuestion's fallback loop reserves and reconciles independently
  // against it (`${requestId}:tenant:${model}` / `:platform:${model}`),
  // so a fallback answer is billed against the model that actually
  // answered, not the originally-preferred one (tokenallocation.md §4).
  const requestId = currentRequestId() ?? crypto.randomUUID()
  let anyAttemptDeniedForCost = false
  const activeTools = actionRelevant ? tools : []
  const activeExecutor = actionRelevant ? executeTool : undefined
  const estimatedInputTokens = estimateAnswerInputTokens(pages, history, question, activeTools)
  // Claude/OpenAI can perform up to three tool rounds plus the final answer.
  // Reserve for every possible provider call so reconciliation cannot turn a
  // cheap single-call estimate into an unexpected cap overrun afterward.
  const maxProviderRounds = activeTools.length > 0 ? 4 : 1

  const authorizeAttempt = async (provider: ProviderKey) => {
    const estimatedReservation = estimateReservationUsd(
      provider,
      estimatedInputTokens * maxProviderRounds,
      800 * maxProviderRounds,
    )
    const reservation = await reserveModelCostSlot(
      chatbotId,
      provider,
      entitlement,
      requestId,
      estimatedReservation,
    )
    if (!reservation.ok) {
      anyAttemptDeniedForCost = true
      log().info({ chatbotId, provider, requestId }, "usage reservation denied: cost cap would be exceeded under concurrency")
      return { ok: false as const }
    }
    return { ok: true as const, commit: reservation.commit }
  }

  const toolResultSink: string[] = []
  const usageSink: AiUsage[] = []
  const aiAnswer = await answerQuestion(
    chatbotName,
    pages,
    question,
    history,
    activeTools,
    activeExecutor,
    toolResultSink,
    usageSink,
    preferredProvider,
    allowedModels,
    authorizeAttempt,
    (event) => {
      void recordRoutingEvent({
        requestId,
        chatbotId,
        conversationId: conversation?.conversationId,
        previousModel: preferredProvider,
        selectedModel: event.selectedModel,
        reason: event.reason,
        providerErrorClass: event.providerErrorClass,
      })
    },
  )

  if (usageSink.length > 0) {
    await recordUsage(chatbotId, usageSink, entitlement)
  }
  if (aiAnswer) {
    const groundingContext = [contextTextFor(pages), ...toolResultSink].join("\n")
    const grounding = verifyGroundedClaims(aiAnswer, groundingContext)
    if (!grounding.ok) {
      log().warn(
        {
          chatbotId,
          ...chatMessageSummary(question),
          failedClaimCount: grounding.failedClaims.length,
          event: "grounding-check-failed",
        },
        "ai answer failed post-generation grounding check, replaced with fallback",
      )
      log().debug(
        { chatbotId, ...chatMessageDebugField(question), failedClaims: grounding.failedClaims },
        "grounding check failure detail",
      )
     
      return { text: fallbackMessage, aiGenerated: false }
    }

    const result: ChatbotAnswer = { text: aiAnswer, aiGenerated: true }
    if (!bypassAnswerCache) {
      await setCached(answerCacheKey, result, env.answerCacheTtlSeconds)
      await incrementCacheMetric("cache.answer_write", { chatbotId })
    }
    return result
  }

  if (anyAttemptDeniedForCost) {
    const block = await getCostCapBlock(chatbotId)
    if (block?.kind === "monthly") {
      // Save-before-block — see the matching comment on the upfront gate
      // check above. This is the more common real-world trigger: the
      // specific request that pushes a chatbot over its monthly cap mid-flight.
      if (customerMemory?.identifier) {
        await saveInterruptedByCreditExhaustion(chatbotId, customerMemory.identifier, question)
      }
      return {
        text: visitorMessageForGate("monthly_credits_exhausted", fallbackMessage),
        aiGenerated: false,
        gateReason: "monthly_credits_exhausted",
      }
    }
    return { text: fallbackMessage, aiGenerated: false }
  }

  const fallback = answerFromSources(question, sources, fallbackMessage)
  return { ...fallback, aiGenerated: false }
}
