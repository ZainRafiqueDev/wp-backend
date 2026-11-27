import type { Request, Response } from "express"

import { asyncHandler } from "../middleware/asyncHandler.js"
import { createContactSubmission } from "../services/contact.service.js"
import type { ContactInput } from "../validators/contact.validator.js"

export const createContact = asyncHandler(async (req: Request, res: Response) => {
  await createContactSubmission(req.body as ContactInput)
  res.status(201).json({ ok: true })
})
