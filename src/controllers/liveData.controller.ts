import type { Request, Response } from "express"

import { asyncHandler } from "../middleware/asyncHandler.js"
import { getBearerToken } from "../middleware/requireAuth.js"
import { createLiveData, deleteLiveData, listLiveData, updateLiveData } from "../services/liveData.service.js"
import type { CreateLiveDataInput, UpdateLiveDataInput } from "../validators/liveData.validator.js"

function param(req: Request, name: string): string {
  const value = req.params[name]
  return Array.isArray(value) ? value[0] : value
}

export const getLiveData = asyncHandler(async (req: Request, res: Response) => {
  const entries = await listLiveData(getBearerToken(req), param(req, "chatbotId"))
  res.status(200).json({ ok: true, entries })
})

export const postLiveData = asyncHandler(async (req: Request, res: Response) => {
  const entry = await createLiveData(getBearerToken(req), param(req, "chatbotId"), req.body as CreateLiveDataInput)
  res.status(201).json({ ok: true, entry })
})

export const patchLiveData = asyncHandler(async (req: Request, res: Response) => {
  const entry = await updateLiveData(getBearerToken(req), param(req, "chatbotId"), param(req, "id"), req.body as UpdateLiveDataInput)
  res.status(200).json({ ok: true, entry })
})

export const removeLiveData = asyncHandler(async (req: Request, res: Response) => {
  await deleteLiveData(getBearerToken(req), param(req, "chatbotId"), param(req, "id"))
  res.status(204).send()
})
