
import { randomUUID } from "node:crypto"

import { Command } from "@langchain/langgraph"

import { log } from "../lib/logger.js"
import { hasBooklyConnected } from "../services/booklyCredentials.service.js"
import { getEntitlementForChatbot } from "../services/billing.service.js"
import { checkAnsweringGate, visitorMessageForGate, type GateReason } from "../services/accessGate.service.js"
import { getBooklyGraph } from "./booklyGraph.js"
import { prepareResumeValue, verificationFromCustomerToken } from "./customerVerificationNodes.js"

export interface BooklyChatResult {
  handled: boolean
  text?: string
  gateReason?: GateReason
  retryAfterSeconds?: number
}


async function isBooklyChatbot(chatbotId: string): Promise<boolean> {
  if (!(await hasBooklyConnected(chatbotId))) return false
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
export function booklyThreadId(chatbotId: string, sessionKey: string): string {
  return `bookly:${chatbotId}:${sessionKey}`
}

export async function tryAnswerWithBooklyGraph(
  chatbotId: string,
  sessionKey: string | null,
  question: string,
  requestId?: string,
  // CS-04: the widget's signed customer session token (from /auth/otp/verify),
  // if it has one. It pre-verifies that customer for this conversation so the
  // visitor isn't asked for a code again; anything invalid is simply ignored.
  customerToken?: string,
): Promise<BooklyChatResult> {
  if (!(await isBooklyChatbot(chatbotId))) return { handled: false }

  const gate = await checkAnsweringGate(chatbotId)
  if (gate.blocked) {
    log().info({ requestId, chatbotId, gateReason: gate.reason }, "bookly graph: answering gate blocked this request")
    return {
      handled: true,
      text: visitorMessageForGate(gate.reason, "Sorry, I'm not able to help with that right now."),
      gateReason: gate.reason,
      retryAfterSeconds: gate.retryAfterSeconds,
    }
  }

  const graph = await getBooklyGraph()
  const threadId = booklyThreadId(chatbotId, sessionKey ?? `ephemeral:${randomUUID()}`)
  const config = { configurable: { thread_id: threadId } }


  const snapshot = await graph.getState(config)
  const isPaused = snapshot.next.length > 0 || snapshot.tasks.some((task) => task.interrupts && task.interrupts.length > 0)

  const graphRunId = isPaused ? (snapshot.values.graphRunId as string) : randomUUID()
  log().info({ requestId, chatbotId, threadId, graphRunId, resuming: isPaused }, "bookly graph invocation")

  const result = isPaused
    ? await graph.invoke(new Command({ resume: await prepareResumeValue(snapshot, chatbotId, threadId, question) }), config)
    : await graph.invoke({ chatbotId, requestId, graphRunId, messages: [{ role: "user", content: question }], ...(await verificationFromCustomerToken(chatbotId, customerToken)) }, config)

  
  const interrupted = (result as { __interrupt__?: { value: unknown }[] }).__interrupt__

  
  if (!interrupted && result.intent === "other") {
    return { handled: false }
  }

  const text = interrupted && interrupted.length > 0 ? String(interrupted[0].value) : result.responseText ?? "Sorry, I didn't quite catch that."

  return { handled: true, text }
}
