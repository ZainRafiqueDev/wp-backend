import { Router } from "express"

import { createTrial } from "../controllers/trial.controller.js"
import { requireDb } from "../middleware/requireDb.js"
import { rateLimitPublicForm } from "../middleware/rateLimitAuthFlows.js"
import { validateBody } from "../middleware/validate.js"
import { trialSchema } from "../validators/trial.validator.js"

export const trialRouter = Router()

trialRouter.post("/", rateLimitPublicForm, requireDb, validateBody(trialSchema), createTrial)
