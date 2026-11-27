import { Router } from "express"

import {
  getSummary,
  postCheckoutSession,
  postPortalSession,
  postTopupSession,
} from "../controllers/billing.controller.js"
import { requireAuth } from "../middleware/requireAuth.js"
import { requireDb } from "../middleware/requireDb.js"
import { validateBody, validateParams } from "../middleware/validate.js"
import { createCheckoutSessionSchema, createTopupSessionSchema } from "../validators/billing.validator.js"
import { chatbotIdParamSchema } from "../validators/chatbot.validator.js"

export const billingRouter = Router()

billingRouter.get("/summary", requireAuth, requireDb, getSummary)

billingRouter.post(
  "/checkout-session",
  requireAuth,
  requireDb,
  validateBody(createCheckoutSessionSchema),
  postCheckoutSession,
)
// Alias matching the preferred API shape (plan click → Checkout redirect).
billingRouter.post(
  "/checkout",
  requireAuth,
  requireDb,
  
  validateBody(createCheckoutSessionSchema),
  postCheckoutSession,
)

billingRouter.post("/portal-session", requireAuth, requireDb, postPortalSession)

billingRouter.post(
  "/chatbots/:chatbotId/topup",
  requireAuth,
  requireDb,
  validateParams(chatbotIdParamSchema),
  validateBody(createTopupSessionSchema),
  postTopupSession,
)
