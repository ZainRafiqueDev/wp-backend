import type { Request, Response } from "express"

import { asyncHandler } from "../middleware/asyncHandler.js"
import { getBearerToken } from "../middleware/requireAuth.js"
import { AppError } from "../lib/errors.js"
import { ATTACHMENT_ACK_MESSAGE, getAttachmentForDownload, listAttachments, uploadAttachment } from "../services/chatAttachments.service.js"
import type { UploadAttachmentBodyInput } from "../validators/chatAttachments.validator.js"

function param(req: Request, name: string): string {
  const value = req.params[name]
  return Array.isArray(value) ? value[0] : value
}

function widgetOriginHeader(req: Request): string | undefined {
  const value = req.headers["x-widget-origin"]
  return Array.isArray(value) ? value[0] : value
}

function refererHeader(req: Request): string | undefined {
  const value = req.headers.referer
  return Array.isArray(value) ? value[0] : value
}

export const postAttachment = asyncHandler(async (req: Request, res: Response) => {
  const file = req.file
  if (!file) {
    throw new AppError(400, "No file was uploaded. Attach a file under the \"file\" field.")
  }
  const { sessionToken, customerToken, customerId, bookingId } = req.body as UploadAttachmentBodyInput
  const attachment = await uploadAttachment({
    chatbotId: param(req, "chatbotId"),
    widgetOrigin: widgetOriginHeader(req),
    refererHeader: refererHeader(req),
    requesterIp: req.ip || "",
    sessionToken,
    customerToken,
    customerId,
    bookingId,
    file,
  })
  res.status(201).json({ ok: true, attachment, ackMessage: ATTACHMENT_ACK_MESSAGE })
})

export const getAttachments = asyncHandler(async (req: Request, res: Response) => {
  const attachments = await listAttachments(getBearerToken(req), param(req, "chatbotId"))
  res.status(200).json({ ok: true, attachments })
})

export const getAttachmentDownload = asyncHandler(async (req: Request, res: Response) => {
  const { attachment, buffer } = await getAttachmentForDownload(getBearerToken(req), param(req, "chatbotId"), param(req, "attachmentId"))
  // Audit 2026-11-27: the file name is visitor-supplied. res.attachment()
  // encodes it properly (ASCII fallback + RFC 5987 filename*); the old
  // hand-built header threw (a 500) on any non-Latin-1 or control character.
  // Content-Type is set after it because attachment() guesses one from the
  // extension.
  res.attachment(attachment.originalFileName)
  res.setHeader("Content-Type", attachment.contentType)
  res.setHeader("X-Content-Type-Options", "nosniff")
  res.status(200).send(buffer)
})
