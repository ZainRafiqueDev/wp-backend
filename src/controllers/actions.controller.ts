import type { Request, Response } from "express"

import { asyncHandler } from "../middleware/asyncHandler.js"
import { getBearerToken } from "../middleware/requireAuth.js"
import { createAction, deleteAction, listActions, updateAction } from "../services/actions.service.js"
import type { CreateActionInput, UpdateActionInput } from "../validators/actions.validator.js"

function param(req: Request, name: string): string {
  const value = req.params[name]
  return Array.isArray(value) ? value[0] : value
}

export const getActions = asyncHandler(async (req: Request, res: Response) => {
  const actions = await listActions(getBearerToken(req), param(req, "chatbotId"))
  res.status(200).json({ ok: true, actions })
})

export const postAction = asyncHandler(async (req: Request, res: Response) => {
  const action = await createAction(getBearerToken(req), param(req, "chatbotId"), req.body as CreateActionInput)
  res.status(201).json({ ok: true, action })
})

export const putAction = asyncHandler(async (req: Request, res: Response) => {
  const action = await updateAction(getBearerToken(req), param(req, "chatbotId"), param(req, "id"), req.body as UpdateActionInput)
  res.status(200).json({ ok: true, action })
})

export const removeAction = asyncHandler(async (req: Request, res: Response) => {
  await deleteAction(getBearerToken(req), param(req, "chatbotId"), param(req, "id"))
  res.status(204).send()
})
