import type { Request, Response } from "express"

import { asyncHandler } from "../middleware/asyncHandler.js"
import { getBearerToken } from "../middleware/requireAuth.js"
import { createLead, getMyActiveLead, updateMyLead } from "../services/lead.service.js"
import type { CreateLeadInput, UpdateLeadInput } from "../validators/lead.validator.js"

export const getLeadMe = asyncHandler(async (req: Request, res: Response) => {
  const lead = await getMyActiveLead(getBearerToken(req))
  res.status(200).json({ ok: true, lead })
})

// No requireAuth on this route (see lead.routes.ts) — an anonymous visitor
// on the public pricing page can submit. getBearerToken returns "" rather
// than throwing when there's no Authorization header, so this works
// identically whether the caller is signed in or not.
export const postLead = asyncHandler(async (req: Request, res: Response) => {
  const lead = await createLead(getBearerToken(req), req.body as CreateLeadInput)
  res.status(201).json({ ok: true, lead })
})

export const patchLeadMe = asyncHandler(async (req: Request, res: Response) => {
  const lead = await updateMyLead(getBearerToken(req), req.body as UpdateLeadInput)
  res.status(200).json({ ok: true, lead })
})
