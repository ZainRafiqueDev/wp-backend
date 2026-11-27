import type { Request, Response } from "express"

import { asyncHandler } from "../middleware/asyncHandler.js"
import { getBearerToken } from "../middleware/requireAuth.js"
import {
  connectBookly,
  disconnectBookly,
  downloadBooklyMeetingHistoryReport,
  getBooklyConnectionStatus,
} from "../services/booklyCredentials.service.js"
import type { ConnectBooklyInput } from "../validators/booklyCredentials.validator.js"

function chatbotIdParam(req: Request): string {
  const value = req.params.chatbotId
  return Array.isArray(value) ? value[0] : value
}

export const getBooklyStatus = asyncHandler(async (req: Request, res: Response) => {
  const status = await getBooklyConnectionStatus(getBearerToken(req), chatbotIdParam(req))
  res.status(200).json({ ok: true, ...status })
})

export const postBooklyConnect = asyncHandler(async (req: Request, res: Response) => {
  const status = await connectBookly(getBearerToken(req), chatbotIdParam(req), req.body as ConnectBooklyInput)
  res.status(201).json({ ok: true, ...status })
})

export const deleteBooklyConnection = asyncHandler(async (req: Request, res: Response) => {
  await disconnectBookly(getBearerToken(req), chatbotIdParam(req))
  res.status(204).send()
})

export const getBooklyMeetingHistoryReport = asyncHandler(async (req: Request, res: Response) => {
  const from = typeof req.query.from === "string" ? req.query.from : undefined
  const to = typeof req.query.to === "string" ? req.query.to : undefined
  const pdf = await downloadBooklyMeetingHistoryReport(getBearerToken(req), chatbotIdParam(req), { from, to })

  res.setHeader("Content-Type", "application/pdf")
  res.setHeader("Content-Disposition", 'attachment; filename="meeting-history.pdf"')
  res.status(200).send(pdf)
})
