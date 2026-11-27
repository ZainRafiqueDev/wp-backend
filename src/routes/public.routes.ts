import { Router } from "express"

import {
  deleteCustomerMemoryHandler,
  getCustomerMemory,
  getWidgetConfig,
  postWidgetChat,
} from "../controllers/public.controller.js"
import { postAttachment } from "../controllers/chatAttachments.controller.js"
import { limitPublicChatConcurrency, observePublicChat, rateLimitPublicChat } from "../middleware/rateLimitPublic.js"
import { rateLimitPublicAttachment } from "../middleware/rateLimitPublicAttachment.js"
import { requireDb } from "../middleware/requireDb.js"
import { uploadAttachmentMiddleware } from "../middleware/uploadAttachment.js"
import { validateBody, validateParams } from "../middleware/validate.js"
import { customerMemoryRequestSchema, publicChatSchema } from "../validators/public.validator.js"
import { uploadAttachmentBodySchema } from "../validators/chatAttachments.validator.js"
import { chatbotIdParamSchema } from "../validators/chatbot.validator.js"

export const publicRouter = Router()


publicRouter.use((_req, res, next) => {
  res.set("Cross-Origin-Resource-Policy", "cross-origin")
  next()
})


publicRouter.get("/chatbots/:chatbotId", requireDb, validateParams(chatbotIdParamSchema), getWidgetConfig)

publicRouter.post(
  "/chatbots/:chatbotId/chat",
  observePublicChat,
  requireDb,
  validateParams(chatbotIdParamSchema),
  rateLimitPublicChat,
  limitPublicChatConcurrency,
  validateBody(publicChatSchema),
  postWidgetChat,
)

// WP-3.4 privacy controls. Both require a fresh OTP proofToken in the body
// (see customerMemoryRequestSchema). POST (not GET) for the export too: the
// token is a credential and has no business sitting in a URL, a referrer
// header, or an access log. Rate-limited on the same bucket as chat so these
// cannot be used to enumerate customer ids faster than chatting could.
publicRouter.post(
  "/chatbots/:chatbotId/memory/export",
  requireDb,
  validateParams(chatbotIdParamSchema),
  rateLimitPublicChat,
  validateBody(customerMemoryRequestSchema),
  getCustomerMemory,
)

publicRouter.post(
  "/chatbots/:chatbotId/memory/delete",
  requireDb,
  validateParams(chatbotIdParamSchema),
  rateLimitPublicChat,
  validateBody(customerMemoryRequestSchema),
  deleteCustomerMemoryHandler,
)

// Phase 3 (2026-10-27): managed chat attachments. rateLimitPublicAttachment
// (per IP per day) runs before the body is ever read; uploadAttachmentMiddleware
// does its own domain/plan/size checks before multer buffers the file; the
// per-conversation cap is a real DB count inside uploadAttachment itself
// (chatAttachments.service.ts), not a third rate limiter here.
publicRouter.post(
  "/chatbots/:chatbotId/attachments",
  requireDb,
  validateParams(chatbotIdParamSchema),
  rateLimitPublicAttachment,
  uploadAttachmentMiddleware,
  validateBody(uploadAttachmentBodySchema),
  postAttachment,
)
