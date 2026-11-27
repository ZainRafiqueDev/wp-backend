import type { Request, Response } from "express"

import { asyncHandler } from "../middleware/asyncHandler.js"
import { getBearerToken } from "../middleware/requireAuth.js"
import {
  chatWithOwnChatbot,
  createChatbot,
  getChatbotById,
  listChatbots,
  retryChatbotCrawl,
  updateChatbotDomain,
  updateChatbotFallbackMessage,
  updateChatbotPreferredModel,
  updateChatbotTheme,
} from "../services/chatbot.service.js"
import { getUsageSummaryForOwner, getUsageWindowSummariesForOwner } from "../services/usage.service.js"
import { getAnalyticsForChatbot } from "../services/analytics.service.js"
import type {
  ChatInput,
  CreateChatbotInput,
  RetryChatbotInput,
  UpdateDomainInput,
  UpdateFallbackMessageInput,
  UpdatePreferredModelInput,
  UpdateThemeInput,
} from "../validators/chatbot.validator.js"


function chatbotIdParam(req: Request): string {
  const value = req.params.chatbotId
  return Array.isArray(value) ? value[0] : value
}

// PHASE A — the dashboard's chatbot list/switcher.
export const getChatbots = asyncHandler(async (req: Request, res: Response) => {
  const chatbots = await listChatbots(getBearerToken(req))
  res.status(200).json({ ok: true, chatbots })
})

export const createFirstChatbot = asyncHandler(async (req: Request, res: Response) => {
  const chatbot = await createChatbot(getBearerToken(req), req.body as CreateChatbotInput)
  res.status(201).json({ ok: true, chatbot })
})

export const retryChatbot = asyncHandler(async (req: Request, res: Response) => {
  const chatbot = await retryChatbotCrawl(getBearerToken(req), chatbotIdParam(req), req.body as RetryChatbotInput)
  res.status(200).json({ ok: true, chatbot })
})

export const setTheme = asyncHandler(async (req: Request, res: Response) => {
  const chatbot = await updateChatbotTheme(getBearerToken(req), chatbotIdParam(req), req.body as UpdateThemeInput)
  res.status(200).json({ ok: true, chatbot })
})

export const setDomain = asyncHandler(async (req: Request, res: Response) => {
  const chatbot = await updateChatbotDomain(getBearerToken(req), chatbotIdParam(req), req.body as UpdateDomainInput)
  res.status(200).json({ ok: true, chatbot })
})

export const setFallbackMessage = asyncHandler(async (req: Request, res: Response) => {
  const chatbot = await updateChatbotFallbackMessage(getBearerToken(req), chatbotIdParam(req), req.body as UpdateFallbackMessageInput)
  res.status(200).json({ ok: true, chatbot })
})

export const setPreferredModel = asyncHandler(async (req: Request, res: Response) => {
  const chatbot = await updateChatbotPreferredModel(getBearerToken(req), chatbotIdParam(req), req.body as UpdatePreferredModelInput)
  res.status(200).json({ ok: true, chatbot })
})


export const getUsageSummary = asyncHandler(async (req: Request, res: Response) => {
  const period = typeof req.query.period === "string" ? req.query.period : undefined
  const token = getBearerToken(req)
  const id = chatbotIdParam(req)
  // `usage` (month, back-compat with the existing dashboard panel) and
  // `windows` (day/week/month together, each with its own per-model cap)
  // fetched in parallel — same underlying chatbot_usage rows, two response
  // shapes for two different UI needs.
  const [usage, windows] = await Promise.all([
    getUsageSummaryForOwner(token, id, period),
    getUsageWindowSummariesForOwner(token, id),
  ])
  res.status(200).json({ ok: true, usage, windows })
})

export const getAnalyticsSummary = asyncHandler(async (req: Request, res: Response) => {
  const analytics = await getAnalyticsForChatbot(getBearerToken(req), chatbotIdParam(req))
  res.status(200).json({ ok: true, analytics })
})

export const getStatus = asyncHandler(async (req: Request, res: Response) => {
  const { chatbot, account } = await getChatbotById(getBearerToken(req), chatbotIdParam(req))
  res.status(200).json({ ok: true, chatbot, account })
})

export const chatWithChatbot = asyncHandler(async (req: Request, res: Response) => {
  const answer = await chatWithOwnChatbot(getBearerToken(req), chatbotIdParam(req), req.body as ChatInput)
  res.status(200).json({ ok: true, ...answer })
})
