import type { Request, Response } from "express"

import { asyncHandler } from "../middleware/asyncHandler.js"
import { createTrialSignup } from "../services/trial.service.js"
import type { TrialInput } from "../validators/trial.validator.js"

export const createTrial = asyncHandler(async (req: Request, res: Response) => {
  await createTrialSignup(req.body as TrialInput)
  res.status(201).json({ ok: true })
})
