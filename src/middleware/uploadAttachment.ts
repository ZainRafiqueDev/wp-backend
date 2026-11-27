import type { NextFunction, Request, Response } from "express"
import multer from "multer"

import { env } from "../env.js"
import { AppError } from "../lib/errors.js"
import { getEntitlementForChatbot } from "../services/billing.service.js"
import { authorizePublicRequest } from "../services/public.service.js"

export const ATTACHMENTS_PAUSED_MESSAGE = "File attachments are turned off for now."

// Same margin/rationale as uploadDocument.ts's middleware.
const MULTIPART_OVERHEAD_MARGIN_BYTES = 64 * 1024

function fileTooLargeError(maxFileBytes: number): AppError {
  return new AppError(413, `File is too large — max ${Math.floor(maxFileBytes / (1024 * 1024))}MB.`, {
    cap: "bytes",
    code: "FILE_TOO_LARGE",
    data: { limit: maxFileBytes },
  })
}

function rejectAfterDraining(req: Request, next: NextFunction, err: AppError) {
  req.on("error", () => undefined)
  req.resume()
  next(err)
}

function widgetOriginHeader(req: Request): string | undefined {
  const value = req.headers["x-widget-origin"]
  return Array.isArray(value) ? value[0] : value
}

function refererHeader(req: Request): string | undefined {
  const value = req.headers.referer
  return Array.isArray(value) ? value[0] : value
}

function chatbotIdParam(req: Request): string {
  const value = req.params.chatbotId
  return Array.isArray(value) ? value[0] : value
}

// Same pre-buffer pattern as uploadDocument.ts, adapted for the public
// (unauthenticated) widget route: domain-checks via authorizePublicRequest
// (same function the chat endpoint uses) before resolving the plan's
// per-file cap, so an oversized or disallowed-domain request never gets
// buffered into memory.
export async function uploadAttachmentMiddleware(req: Request, res: Response, next: NextFunction) {
  try {
    // Uploads paused (no malware scanner running): refuse before reading the
    // body, with a message that doesn't wrongly blame the visitor's plan.
    if (env.documentScanPauseUploads) {
      return rejectAfterDraining(req, next, new AppError(503, ATTACHMENTS_PAUSED_MESSAGE))
    }
    const chatbotId = chatbotIdParam(req)
    const chatbot = await authorizePublicRequest(chatbotId, widgetOriginHeader(req), refererHeader(req), req.ip || "")
    const entitlement = await getEntitlementForChatbot(chatbot.id)
    if (!entitlement.chatAttachments.enabled) {
      return next(new AppError(402, "File attachments require the Crawl Plus plan or higher."))
    }

    const maxFileBytes = entitlement.chatAttachments.maxFileSizeBytes
    const contentLength = Number(req.headers["content-length"])
    if (Number.isFinite(contentLength) && contentLength > maxFileBytes + MULTIPART_OVERHEAD_MARGIN_BYTES) {
      return rejectAfterDraining(req, next, fileTooLargeError(maxFileBytes))
    }

    const singleFile = multer({
      storage: multer.memoryStorage(),
      limits: { fileSize: maxFileBytes, files: 1 },
    }).single("file")

    singleFile(req, res, (err: unknown) => {
      if (!err) return next()
      console.error("[uploadAttachment] multer rejected the request:", err)
      if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
        return rejectAfterDraining(req, next, fileTooLargeError(maxFileBytes))
      }
      return next(new AppError(400, "Couldn't process the uploaded file."))
    })
  } catch (err) {
    next(err)
  }
}
