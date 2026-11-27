import { Router } from "express"

import { createDemoChat } from "../controllers/demo.controller.js"
import { rateLimitPublicForm } from "../middleware/rateLimitAuthFlows.js"
import { validateBody } from "../middleware/validate.js"
import { demoChatSchema } from "../validators/demo.validator.js"

export const demoRouter = Router()

demoRouter.post("/chat", rateLimitPublicForm, validateBody(demoChatSchema), createDemoChat)
