import { Router } from "express"

import { createWaitlistSignup } from "../controllers/waitlist.controller.js"
import { requireDb } from "../middleware/requireDb.js"
import { rateLimitPublicForm } from "../middleware/rateLimitAuthFlows.js"
import { validateBody } from "../middleware/validate.js"
import { waitlistSchema } from "../validators/waitlist.validator.js"

export const waitlistRouter = Router()

waitlistRouter.post("/", rateLimitPublicForm, requireDb, validateBody(waitlistSchema), createWaitlistSignup)
