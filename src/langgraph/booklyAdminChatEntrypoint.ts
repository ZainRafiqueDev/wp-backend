
import { randomUUID } from "node:crypto"

import { Command } from "@langchain/langgraph"

import { AppError } from "../lib/errors.js"
import { log } from "../lib/logger.js"
import { setTenantContext } from "../lib/tenantContext.js"
import { hasBooklyConnected } from "../services/booklyCredentials.service.js"
import { getEntitlementForChatbot } from "../services/billing.service.js"
import { requireBooklyAdminSession } from "../services/booklyAdminAuth.service.js"
import { getBooklyAdminGraph } from "./booklyAdminGraph.js"

export interface BooklyAdminChatResult {
  text: string
}

export async function answerBooklyAdminChat(
  chatbotId: string,
  conversationId: string | null,
  message: string,
  booklyAdminToken: string,
  requestId?: string,
): Promise<BooklyAdminChatResult> {
  // This route isn't authenticated by a ChatMate360 JWT — the caller proves
  // identity via a Bookly-issued admin session token instead, verified a
  // few lines down by requireBooklyAdminSession. bindTenantContext
  // (middleware/tenantContext.ts) only pre-populates chatbotId for
  // /public/chatbots/:id URLs, so this route's RLS context is otherwise
  // empty — every read below (hasBooklyConnected, entitlement, the Bookly
  // credential lookup inside requireBooklyAdminSession) would silently see
  // zero rows and fail closed. Setting it here from the URL's chatbotId
  // mirrors the public-widget pattern: RLS enablement, not the actual
  // authorization boundary — real authorization is requireBooklyAdminSession
  // verifying the token against Bookly itself, a few lines below.
  setTenantContext({ scope: "public", chatbotId })

  if (!(await hasBooklyConnected(chatbotId))) {
    throw new AppError(403, "This chatbot has no connected Bookly resource.")
  }
  const entitlement = await getEntitlementForChatbot(chatbotId)
  if (entitlement.plan !== "full_custom") {
    throw new AppError(402, "The admin-chat automation requires the Full Custom plan.")
  }

  
  const admin = await requireBooklyAdminSession(chatbotId, booklyAdminToken)

  const graph = await getBooklyAdminGraph()
  const threadId = conversationId ?? randomUUID()
  
  const config = { configurable: { thread_id: threadId, booklyAdminToken } }

  const snapshot = await graph.getState(config)
  const isPaused = snapshot.next.length > 0
  const graphRunId = isPaused ? (snapshot.values.graphRunId as string) : randomUUID()

  log().info({ requestId, chatbotId, threadId, graphRunId, adminId: admin.id, resuming: isPaused }, "bookly admin chat invocation")

  const result = isPaused
    ? await graph.invoke(new Command({ resume: message }), config)
    : await graph.invoke(
        { chatbotId, adminId: admin.id, adminEmail: admin.email, requestId, graphRunId, messages: [{ role: "user", content: message }] },
        config,
      )

  const interrupted = (result as { __interrupt__?: { value: unknown }[] }).__interrupt__
  const text = interrupted && interrupted.length > 0 ? String(interrupted[0].value) : result.responseText ?? "Sorry, I didn't quite catch that."

  return { text }
}
