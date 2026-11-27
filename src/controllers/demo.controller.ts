import type { Request, Response } from "express"

import { asyncHandler } from "../middleware/asyncHandler.js"
import { replyToDemoMessage } from "../services/demo.service.js"
import type { DemoChatInput } from "../validators/demo.validator.js"

export const createDemoChat = asyncHandler(async (req: Request, res: Response) => {
  const { message } = req.body as DemoChatInput
  const result = replyToDemoMessage(message)
  res.json({ ok: true, ...result })
})
