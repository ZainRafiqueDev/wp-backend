
import { randomUUID } from "node:crypto"

import { Command } from "@langchain/langgraph"

import { log } from "../lib/logger.js"
import { hasWooCommerceConnected } from "../services/commerceCredentials.service.js"
import { getEntitlementForChatbot } from "../services/billing.service.js"
import { drainUndeliveredNotifications } from "../services/commerceNotification.service.js"
import { checkAnsweringGate, visitorMessageForGate, type GateReason } from "../services/accessGate.service.js"
import { getCommerceGraph } from "./commerceGraph.js"
import { prepareResumeValue, verificationFromCustomerToken, verifiedCustomerIdFor } from "./customerVerificationNodes.js"
import type { CatalogProduct } from "../services/productCatalog.service.js"

export interface CommerceProductCard {
  name: string
  price: number | null
  description: string | null
  imageUrl: string | null
  productUrl: string | null
}

export interface CommerceChatResult {
  handled: boolean
  text?: string
  gateReason?: GateReason
  retryAfterSeconds?: number
  products?: CommerceProductCard[]
}

function toProductCards(products: CatalogProduct[]): CommerceProductCard[] {
  return products.map((p) => ({ name: p.name, price: p.price, description: p.description, imageUrl: p.imageUrl, productUrl: p.productUrl }))
}


async function isCommerceChatbot(chatbotId: string): Promise<boolean> {
  if (!(await hasWooCommerceConnected(chatbotId))) return false
  const entitlement = await getEntitlementForChatbot(chatbotId)
  return entitlement.plan === "full_custom"
}

/**
 * CS-04: the LangGraph thread for a chat session. `sessionKey` is already
 * namespaced by surface by the caller (customerSession.service chatSessionKey:
 * "widget:<server-issued sid>" or "preview:<owner user id>:<id>"); the graph
 * name and chatbot id are added here so no two chatbots, graphs or surfaces
 * can ever share a thread (and so its verified identity).
 */
export function commerceThreadId(chatbotId: string, sessionKey: string): string {
  return `commerce:${chatbotId}:${sessionKey}`
}

export async function tryAnswerWithCommerceGraph(
  chatbotId: string,
  sessionKey: string | null,
  question: string,
  requestId?: string,
  // CS-04: the widget's signed customer session token (from /auth/otp/verify),
  // if it has one. It pre-verifies that customer for this conversation so the
  // visitor isn't asked for a code again; anything invalid is simply ignored.
  customerToken?: string,
): Promise<CommerceChatResult> {
  if (!(await isCommerceChatbot(chatbotId))) return { handled: false }

  
  const gate = await checkAnsweringGate(chatbotId)
  if (gate.blocked) {
    log().info({ requestId, chatbotId, gateReason: gate.reason }, "commerce graph: answering gate blocked this request")
    return {
      handled: true,
      text: visitorMessageForGate(gate.reason, "Sorry, I'm not able to help with that right now."),
      gateReason: gate.reason,
      retryAfterSeconds: gate.retryAfterSeconds,
    }
  }

  const graph = await getCommerceGraph()
  
  const threadId = commerceThreadId(chatbotId, sessionKey ?? `ephemeral:${randomUUID()}`)
  const config = { configurable: { thread_id: threadId } }

  const snapshot = await graph.getState(config)
  const isPaused = snapshot.next.length > 0

  const graphRunId = isPaused ? (snapshot.values.graphRunId as string) : randomUUID()
  log().info({ requestId, chatbotId, threadId, graphRunId, resuming: isPaused }, "commerce graph invocation")

  const result = isPaused
    ? await graph.invoke(new Command({ resume: await prepareResumeValue(snapshot, chatbotId, threadId, question) }), config)
    : await graph.invoke({ chatbotId, requestId, graphRunId, messages: [{ role: "user", content: question }], ...(await verificationFromCustomerToken(chatbotId, customerToken)) }, config)

  
  const interrupted = (result as { __interrupt__?: { value: unknown }[] }).__interrupt__
  let text: string
  if (interrupted && interrupted.length > 0) {
    text = String(interrupted[0].value)
  } else {
    text = result.responseText ?? "Sorry, I didn't quite catch that."
  }
  // CS-04: queued notifications (booking numbers) go only to a customer who
  // proved they own the email, never to whoever typed it.
  const verifiedCustomerId = result.chatbotId === chatbotId ? verifiedCustomerIdFor(result) : null
  if (verifiedCustomerId) {
    const notifications = await drainUndeliveredNotifications(chatbotId, verifiedCustomerId)
    if (notifications.length > 0) {
      const prefix = notifications.map((n) => (n.payload as { message?: string }).message).filter(Boolean).join(" ")
      text = `${prefix} ${text}`.trim()
    }
  }

  
  const products =
    !interrupted && result.intent === "product_question" && result.candidateProducts?.length ? toProductCards(result.candidateProducts) : undefined

  return { handled: true, text, products }
}
