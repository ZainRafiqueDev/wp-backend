import type { Request, Response } from "express"

import { asyncHandler } from "../middleware/asyncHandler.js"
import { receiveWooCommerceWebhook } from "../services/commerceWebhookReceive.service.js"

function chatbotIdParam(req: Request): string {
  const value = req.params.chatbotId
  return Array.isArray(value) ? value[0] : value
}

export const postWooCommerceWebhook = asyncHandler(async (req: Request, res: Response) => {
  
  const rawBody = Buffer.isBuffer(req.body) ? req.body : undefined
  const signature = req.header("x-wc-webhook-signature")
  const topic = req.header("x-wc-webhook-topic")
  await receiveWooCommerceWebhook(chatbotIdParam(req), rawBody, signature, topic)
  res.status(200).json({ ok: true })
})
