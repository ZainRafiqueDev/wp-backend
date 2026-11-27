import { answerChatbotQuestion, type CustomerMemoryContext } from "../lib/answerChatbotQuestion.js"
import { chatbotRowToChatbot, defaultFallbackMessage, type Chatbot } from "../lib/chatbot.js"
import { pool } from "../lib/db.js"
import { verifyCustomerSessionToken, verifyOtpProofToken } from "../lib/auth.js"
import { AppError } from "../lib/errors.js"
import { originAllowed } from "../lib/originAllowed.js"
import { setTenantContext } from "../lib/tenantContext.js"
import { consumeStrictPublicChatLimit } from "../middleware/rateLimitPublic.js"
import { loadConversationContext, recordTurn } from "./conversation.service.js"
import { customerBelongsToChatbot, getCustomerIdentity } from "./customerIdentity.service.js"
import { getLiveDataForAnswering } from "./liveData.service.js"
import { currentRequestId } from "../lib/requestContext.js"
import {
  customerIdentifierFromEmail,
  deleteCustomerMemory,
  exportCustomerMemory,
  extractFactsAfterTurn,
  getSessionSummary,
  listCustomerFacts,
  updateSessionSummaryAfterTurn,
} from "./sessionMemory.service.js"
import { tryAnswerWithCommerceGraph } from "../langgraph/commerceEntrypoint.js"
import { tryAnswerWithBooklyGraph } from "../langgraph/booklyEntrypoint.js"
import { getEntitlementForChatbot } from "./billing.service.js"
import { chatSessionKey, resolveWidgetSession } from "./customerSession.service.js"

// Resolves an optional, caller-supplied customerId (set once a visitor has
// verified their email, e.g. via OTP for an order lookup) into cross-session
// memory context. Anything that doesn't check out — no id, wrong tenant, no
// email on file — degrades to no memory rather than failing the request;
// this is an enhancement, never a requirement for answering.
async function loadCustomerMemory(chatbotId: string, customerToken: string | undefined): Promise<CustomerMemoryContext | null> {
  if (!customerToken) return null
  const session = verifyCustomerSessionToken(customerToken)
  if (!session || session.chatbotId !== chatbotId) return null
  const customerId = session.customerId
  if (!(await customerBelongsToChatbot(customerId, chatbotId))) return null
  const identity = await getCustomerIdentity(customerId)
  if (!identity?.email) return null

  const identifier = customerIdentifierFromEmail(chatbotId, identity.email)
  const [summary, facts] = await Promise.all([
    getSessionSummary(chatbotId, identifier),
    listCustomerFacts(chatbotId, identifier),
  ])
  return {
    identifier,
    summaryMd: summary?.summaryMd ?? null,
    interruptedByCreditExhaustion: summary?.interruptedByCreditExhaustion ?? false,
    facts: facts.map((fact) => ({ key: fact.key, value: fact.value })),
  }
}


/**
 * WP-3.4 privacy endpoints share this resolution step. The caller must present
 * a fresh OTP proof token, issued for this chatbot, with a purpose that
 * involved verifying the customer's email. The customer comes from the token.
 * A missing, expired, forged or wrong-chatbot token is a 401. The customer must
 * then still exist, belong to this chatbot, and have an email (the thing the
 * memory key is derived from); otherwise it is a 404.
 */
async function requireMemoryIdentifier(chatbotId: string, proofToken: string): Promise<string> {
  const proof = verifyOtpProofToken(proofToken)
  if (
    !proof ||
    (proof.purpose !== "ORDER_ACCESS" && proof.purpose !== "SENSITIVE_ACTION") ||
    proof.chatbotId !== chatbotId ||
    !proof.customerId
  ) {
    throw new AppError(401, "Verify your email to manage your stored memory.")
  }
  const customerId = proof.customerId
  if (!(await customerBelongsToChatbot(customerId, chatbotId))) {
    throw new AppError(404, "No stored memory for this customer.")
  }
  const identity = await getCustomerIdentity(customerId)
  if (!identity?.email) throw new AppError(404, "No stored memory for this customer.")
  return customerIdentifierFromEmail(chatbotId, identity.email)
}

export async function exportPublicCustomerMemory(
  chatbotId: string,
  widgetOrigin: string | undefined,
  refererHeader: string | undefined,
  requesterIp: string,
  proofToken: string,
) {
  const chatbot = await authorizePublicRequest(chatbotId, widgetOrigin, refererHeader, requesterIp)
  const identifier = await requireMemoryIdentifier(chatbot.id, proofToken)
  return exportCustomerMemory(chatbot.id, identifier)
}

export async function deletePublicCustomerMemory(
  chatbotId: string,
  widgetOrigin: string | undefined,
  refererHeader: string | undefined,
  requesterIp: string,
  proofToken: string,
) {
  const chatbot = await authorizePublicRequest(chatbotId, widgetOrigin, refererHeader, requesterIp)
  const identifier = await requireMemoryIdentifier(chatbot.id, proofToken)
  return deleteCustomerMemory(chatbot.id, identifier)
}

async function getChatbotById(chatbotId: string): Promise<Chatbot | null> {
  if (!pool) return null
  const { rows } = await pool.query(
    "select id, name, sources, theme, allowed_domain, created_at, status, status_reason, fallback_message, preferred_model " +
      "from chatbots where id = $1",
    [chatbotId],
  )
  return rows[0] ? chatbotRowToChatbot(rows[0]) : null
}


export async function authorizePublicRequest(
  chatbotId: string,
  widgetOrigin: string | undefined,
  refererHeader: string | undefined,
  requesterIp: string,
): Promise<Chatbot> {
  setTenantContext({ scope: "public", chatbotId })
  const chatbot = await getChatbotById(chatbotId)
  if (!chatbot) throw new AppError(404, "Chatbot not found")
  if (!widgetOrigin || !chatbot.allowedDomain || !originAllowed(widgetOrigin, chatbot.allowedDomain)) {
    throw new AppError(403, "This domain is not allowed to embed this chatbot")
  }

  const refererMismatch = Boolean(refererHeader) && !originAllowed(refererHeader as string, chatbot.allowedDomain)
  if (refererMismatch) {
    await consumeStrictPublicChatLimit(`${chatbotId}:${requesterIp}`)
  }

  return chatbot
}

export async function getPublicChatbot(
  chatbotId: string,
  widgetOrigin: string | undefined,
  refererHeader: string | undefined,
  requesterIp: string,
) {
  const chatbot = await authorizePublicRequest(chatbotId, widgetOrigin, refererHeader, requesterIp)
  const { chatAttachments: caps } = await getEntitlementForChatbot(chatbot.id)
  return {
    id: chatbot.id,
    name: chatbot.name,
    theme: chatbot.theme,
    // Only what the widget needs to decide whether to show the attach
    // button and pre-check a file client-side. The server re-checks all of
    // this (and the account storage pool) on upload regardless.
    attachments: {
      enabled: caps.enabled,
      maxFileSizeBytes: caps.maxFileSizeBytes,
      maxFilesPerMessage: caps.maxFilesPerMessage,
      allowedTypes: caps.allowedTypes,
    },
  }
}

export async function answerPublicChat(
  chatbotId: string,
  widgetOrigin: string | undefined,
  refererHeader: string | undefined,
  requesterIp: string,
  message: string,
  history: { role: "user" | "assistant"; content: string }[],

  // CS-04: the server-issued session token from a previous response. A
  // client-chosen session id is no longer a session key (anyone who learned
  // it could resume that conversation and its verified identity).
  sessionToken?: string,
  customerToken?: string,
  // Legacy widgets still send their own session id. It is never used as a
  // key; it only signals "this client keeps a conversation", so a new
  // server session is issued for it.
  wantsSession = false,
) {
  const chatbot = await authorizePublicRequest(chatbotId, widgetOrigin, refererHeader, requesterIp)
  const session = sessionToken || wantsSession ? resolveWidgetSession(chatbot.id, sessionToken) : null
  const sessionKey = session ? chatSessionKey("widget", session.sid) : null
  const sessionField = session ? { sessionToken: session.sessionToken } : {}

  const commerceResult = await tryAnswerWithCommerceGraph(chatbot.id, sessionKey, message, currentRequestId(), customerToken)
  if (commerceResult.handled) {
    return { text: commerceResult.text ?? "", aiGenerated: true, gateReason: commerceResult.gateReason, retryAfterSeconds: commerceResult.retryAfterSeconds, products: commerceResult.products, ...sessionField }
  }

  const booklyResult = await tryAnswerWithBooklyGraph(chatbot.id, sessionKey, message, currentRequestId(), customerToken)
  if (booklyResult.handled) {
    return { text: booklyResult.text ?? "", aiGenerated: true, gateReason: booklyResult.gateReason, retryAfterSeconds: booklyResult.retryAfterSeconds, ...sessionField }
  }

  const liveData = await getLiveDataForAnswering(chatbot.id)
  const customerMemory = await loadCustomerMemory(chatbot.id, customerToken)

  let effectiveHistory = history
  let conversation: { conversationId: string; pinnedModel: string | null } | undefined
  if (sessionKey) {
    const context = await loadConversationContext(chatbot.id, sessionKey)
    effectiveHistory = context.history
    conversation = { conversationId: context.conversationId, pinnedModel: context.pinnedModel }
  }

  const answer = await answerChatbotQuestion(
    chatbot.id,
    chatbot.name,
    chatbot.sources,
    message,
    effectiveHistory,
    chatbot.fallbackMessage || defaultFallbackMessage(chatbot.name),
    liveData,
    conversation,
    chatbot.preferredModel,
    customerMemory,
  )


  if (conversation && !answer.gateReason) {
    await recordTurn(conversation.conversationId, message, answer.text)
  }
  // Cross-session memory update — independent of whether this chatbot uses
  // conversation-level history at all, only of whether we have a stable
  // customer identity to key it on and a real (non-blocked) answer to fold in.
  if (customerMemory && answer.aiGenerated && !answer.gateReason) {
    // Summary and facts are two independent views of the same turn, so they
    // run together — neither throws, and a failure in one must not skip the other.
    await Promise.all([
      updateSessionSummaryAfterTurn(chatbot.id, customerMemory.identifier, message, answer.text),
      extractFactsAfterTurn(chatbot.id, customerMemory.identifier, message, answer.text),
    ])
  }

  return { ...answer, ...sessionField }
}
