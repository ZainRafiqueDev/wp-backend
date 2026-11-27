import type { Request, Response } from "express"

import { getCreditGrantConfigError, isCreditGrantingEnabled } from "../env.js"
import { asyncHandler } from "../middleware/asyncHandler.js"
import { getHnswIndexHealth } from "../lib/pgvectorHnsw.js"
import { getStripeInboxHealth } from "../services/stripeWebhookInbox.service.js"

export const getHealth = asyncHandler(async (_req: Request, res: Response) => {
  const creditGrantError = getCreditGrantConfigError()
  const degraded = !isCreditGrantingEnabled()
  const [stripeInbox, hnsw] = await Promise.all([getStripeInboxHealth(), getHnswIndexHealth()])
  res.json({
    ok: true,
    status: degraded ? "degraded" : "ok",
    service: "chatmate360-backend",
    demo: "sandbox",
    billing: {
      creditGrants: degraded ? "disabled" : "enabled",
      reason: creditGrantError,
      stripeInbox,
    },
    retrieval: { hnsw },
  })
})
