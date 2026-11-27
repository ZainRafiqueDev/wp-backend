import type { Request, Response } from "express"

import { asyncHandler } from "../middleware/asyncHandler.js"
import {
  answerPublicChat,
  deletePublicCustomerMemory,
  exportPublicCustomerMemory,
  getPublicChatbot,
} from "../services/public.service.js"
import type { CustomerMemoryRequestInput, PublicChatInput } from "../validators/public.validator.js"


function widgetOriginHeader(req: Request): string | undefined {
  const value = req.headers["x-widget-origin"]
  return Array.isArray(value) ? value[0] : value
}


function refererHeader(req: Request): string | undefined {
  const value = req.headers.referer
  return Array.isArray(value) ? value[0] : value
}


function chatbotIdParam(req: Request): string {
  const value = req.params.chatbotId
  return Array.isArray(value) ? value[0] : value
}

export const getWidgetConfig = asyncHandler(async (req: Request, res: Response) => {
  const chatbot = await getPublicChatbot(chatbotIdParam(req), widgetOriginHeader(req), refererHeader(req), req.ip || "")
  res.status(200).json({ ok: true, ...chatbot })
})

export const postWidgetChat = asyncHandler(async (req: Request, res: Response) => {
  const { message, history, sessionId, sessionToken, customerToken } = req.body as PublicChatInput
  const chatbotId = chatbotIdParam(req)
  const answer = await answerPublicChat(
    chatbotId,
    widgetOriginHeader(req),
    refererHeader(req),
    req.ip || "",
    message,
    history,
    sessionToken,
    customerToken,
    Boolean(sessionId),
  )
  res.locals.aiGenerated = answer.aiGenerated
  res.locals.gateReason = answer.gateReason
  res.status(200).json({ ok: true, ...answer })
})

// WP-3.4 privacy controls: what the widget stores about a verified customer,
// and erasing it on request.
export const getCustomerMemory = asyncHandler(async (req: Request, res: Response) => {
  const { proofToken } = req.body as CustomerMemoryRequestInput
  const memory = await exportPublicCustomerMemory(
    chatbotIdParam(req),
    widgetOriginHeader(req),
    refererHeader(req),
    req.ip || "",
    proofToken,
  )
  res.status(200).json({ ok: true, memory })
})

export const deleteCustomerMemoryHandler = asyncHandler(async (req: Request, res: Response) => {
  const { proofToken } = req.body as CustomerMemoryRequestInput
  const deleted = await deletePublicCustomerMemory(
    chatbotIdParam(req),
    widgetOriginHeader(req),
    refererHeader(req),
    req.ip || "",
    proofToken,
  )
  res.status(200).json({ ok: true, deleted })
})
