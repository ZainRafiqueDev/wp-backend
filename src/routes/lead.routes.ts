import { Router } from "express"

import { getLeadMe, patchLeadMe, postLead } from "../controllers/lead.controller.js"
import { requireAuth } from "../middleware/requireAuth.js"
import { requireDb } from "../middleware/requireDb.js"
import { rateLimitPublicForm } from "../middleware/rateLimitAuthFlows.js"
import { validateBody } from "../middleware/validate.js"
import { createLeadSchema, updateLeadSchema } from "../validators/lead.validator.js"

export const leadRouter = Router()

// Public — no requireAuth. An anonymous visitor on the pricing page can
// submit; the controller/service resolve an optional bearer token to
// attach the lead to an account when one is signed in.
leadRouter.post("/", rateLimitPublicForm, requireDb, validateBody(createLeadSchema), postLead)

leadRouter.get("/me", requireAuth, requireDb, getLeadMe)
leadRouter.patch("/me", requireAuth, requireDb, validateBody(updateLeadSchema), patchLeadMe)
