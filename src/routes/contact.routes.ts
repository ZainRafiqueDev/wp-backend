import { Router } from "express"

import { createContact } from "../controllers/contact.controller.js"
import { requireDb } from "../middleware/requireDb.js"
import { rateLimitPublicForm } from "../middleware/rateLimitAuthFlows.js"
import { validateBody } from "../middleware/validate.js"
import { contactSchema } from "../validators/contact.validator.js"

export const contactRouter = Router()

contactRouter.post("/", rateLimitPublicForm, requireDb, validateBody(contactSchema), createContact)
