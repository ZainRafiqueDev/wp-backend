import type { Request, Response } from "express"

import { asyncHandler } from "../middleware/asyncHandler.js"
import { getBearerToken } from "../middleware/requireAuth.js"
import { deleteIntegration, getIntegrationStatus, upsertIntegration } from "../services/integration.service.js"
import type { UpsertIntegrationInput } from "../validators/integration.validator.js"

function chatbotIdParam(req: Request): string {
  const value = req.params.chatbotId
  return Array.isArray(value) ? value[0] : value
}

export const getIntegration = asyncHandler(async (req: Request, res: Response) => {
  const status = await getIntegrationStatus(getBearerToken(req), chatbotIdParam(req))
  res.status(200).json({ ok: true, integration: status })
})


export const putIntegration = asyncHandler(async (req: Request, res: Response) => {
  const { apiKey, apiBaseUrl } = req.body as UpsertIntegrationInput
  const status = await upsertIntegration(getBearerToken(req), chatbotIdParam(req), apiKey, apiBaseUrl)
  res.status(200).json({ ok: true, integration: status })
})

export const removeIntegration = asyncHandler(async (req: Request, res: Response) => {
  await deleteIntegration(getBearerToken(req), chatbotIdParam(req))
  res.status(204).send()
})
