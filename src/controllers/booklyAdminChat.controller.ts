import type { Request, Response } from "express"

import { asyncHandler } from "../middleware/asyncHandler.js"
import { currentRequestId } from "../lib/requestContext.js"
import { answerBooklyAdminChat } from "../langgraph/booklyAdminChatEntrypoint.js"
import { listAdminAuditLogForChatbot } from "../services/booklyAdminAudit.service.js"
import { getBearerToken } from "../middleware/requireAuth.js"
import { requireOwnedChatbotId } from "../lib/chatbotOwnership.js"
import { verifyAccessToken } from "../lib/auth.js"
import { AppError } from "../lib/errors.js"
import { resolveTenantContext } from "../lib/tenancy.js"
import type { BooklyAdminChatInput } from "../validators/booklyAdminChat.validator.js"

function chatbotIdParam(req: Request): string {
  const value = req.params.chatbotId
  return Array.isArray(value) ? value[0] : value
}


export const postBooklyAdminChat = asyncHandler(async (req: Request, res: Response) => {
  const { message, conversationId, booklyAdminToken } = req.body as BooklyAdminChatInput
  const result = await answerBooklyAdminChat(chatbotIdParam(req), conversationId ?? null, message, booklyAdminToken, currentRequestId())
  res.status(200).json({ ok: true, text: result.text })
})


export const getBooklyAdminAuditLog = asyncHandler(async (req: Request, res: Response) => {
  const actorUserId = verifyAccessToken(getBearerToken(req))
  if (!actorUserId) throw new AppError(401, "Please sign in again.")
  const { tenantUserId } = await resolveTenantContext(actorUserId, "admin")
  const ownedId = await requireOwnedChatbotId(tenantUserId, chatbotIdParam(req))
  const rows = await listAdminAuditLogForChatbot(ownedId)
  res.status(200).json({ ok: true, entries: rows })
})
