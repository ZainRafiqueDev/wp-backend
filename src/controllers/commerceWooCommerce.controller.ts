import type { Request, Response } from "express"

import { asyncHandler } from "../middleware/asyncHandler.js"
import { getBearerToken } from "../middleware/requireAuth.js"
import { connectWooCommerce, disconnectWooCommerce, getWooCommerceConnectionStatus, requireFullCustomPlan } from "../services/commerceCredentials.service.js"
import { requireOwnedChatbotId } from "../lib/chatbotOwnership.js"
import { verifyAccessToken } from "../lib/auth.js"
import { AppError } from "../lib/errors.js"
import { enqueueCatalogSync } from "../lib/commerceQueue.js"
import { resolveTenantContext } from "../lib/tenancy.js"
import type { ConnectWooCommerceInput } from "../validators/commerceWooCommerce.validator.js"

function chatbotIdParam(req: Request): string {
  const value = req.params.chatbotId
  return Array.isArray(value) ? value[0] : value
}

export const getWooCommerceStatus = asyncHandler(async (req: Request, res: Response) => {
  const status = await getWooCommerceConnectionStatus(getBearerToken(req), chatbotIdParam(req))
  res.status(200).json({ ok: true, ...status })
})

export const postWooCommerceConnect = asyncHandler(async (req: Request, res: Response) => {
  const status = await connectWooCommerce(getBearerToken(req), chatbotIdParam(req), req.body as ConnectWooCommerceInput)
  res.status(201).json({ ok: true, ...status })
})

export const deleteWooCommerceConnection = asyncHandler(async (req: Request, res: Response) => {
  await disconnectWooCommerce(getBearerToken(req), chatbotIdParam(req))
  res.status(204).send()
})


export const postWooCommerceSync = asyncHandler(async (req: Request, res: Response) => {
  const actorUserId = verifyAccessToken(getBearerToken(req))
  if (!actorUserId) throw new AppError(401, "Please sign in again.")
  const chatbotId = chatbotIdParam(req)
  const { tenantUserId } = await resolveTenantContext(actorUserId, "admin")
  const ownedId = await requireOwnedChatbotId(tenantUserId, chatbotId)
  await requireFullCustomPlan(ownedId)
  await enqueueCatalogSync({ chatbotId: ownedId })
  res.status(202).json({ ok: true, message: "Catalog sync started." })
})
