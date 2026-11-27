import type { Request, Response } from "express"

import { asyncHandler } from "../middleware/asyncHandler.js"
import { addToWaitlist } from "../services/waitlist.service.js"
import type { WaitlistInput } from "../validators/waitlist.validator.js"

export const createWaitlistSignup = asyncHandler(async (req: Request, res: Response) => {
  const { email } = req.body as WaitlistInput
  await addToWaitlist(email)
  res.status(201).json({ ok: true })
})
