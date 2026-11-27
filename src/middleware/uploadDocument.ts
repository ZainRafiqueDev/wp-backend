import type { NextFunction, Request, Response } from "express"
import multer from "multer"

import { AppError } from "../lib/errors.js"
import { verifyAccessToken } from "../lib/auth.js"
import { requireOwnedChatbotId } from "../lib/chatbotOwnership.js"
import { getEntitlementForChatbot } from "../services/billing.service.js"
import { loadIngestCaps } from "../services/documentIngestion.service.js"
import { resolveTenantContext } from "../lib/tenancy.js"
import { getBearerToken } from "./requireAuth.js"

// Multipart envelope overhead (boundary markers, field/part headers,
// filename) on top of the actual file bytes — generous on purpose. The
// Content-Length pre-check only needs to catch GROSSLY oversized requests
// before they're read at all; the precise, authoritative byte limit is
// multer's own limits.fileSize below, which operates on the file stream
// itself (no envelope bytes counted).
const MULTIPART_OVERHEAD_MARGIN_BYTES = 64 * 1024

function fileTooLargeError(maxFileBytes: number): AppError {
  return new AppError(413, `File is too large — max ${Math.floor(maxFileBytes / (1024 * 1024))}MB.`, {
    cap: "bytes",
    code: "FILE_TOO_LARGE",
    data: { limit: maxFileBytes },
  })
}

// Rejecting a request without reading its body leaves unread bytes on the
// socket — the client sees ECONNRESET instead of the clean error response.
// Draining (not parsing) the body lets the response complete normally.
function rejectAfterDraining(req: Request, next: NextFunction, err: AppError) {
  req.on("error", () => undefined)
  req.resume()
  next(err)
}

// Resolves the plan's per-file size cap BEFORE multer buffers anything, so
// an oversized upload is rejected by Content-Length (or multer's own
// limits.fileSize, set dynamically per-request below) instead of being
// fully read into memory first. The business-logic ground truth is still
// documentIngestion.service.ts's own assertFileBytes/assertDocumentCount —
// this middleware only short-circuits the obviously-too-large case early.
export async function uploadDocument(req: Request, res: Response, next: NextFunction) {
  try {
    const token = getBearerToken(req)
    const actorUserId = verifyAccessToken(token)
    if (!actorUserId) {
      return next(new AppError(401, "Please sign in again."))
    }

    const chatbotIdParam = req.params.chatbotId
    const chatbotId = Array.isArray(chatbotIdParam) ? chatbotIdParam[0] : chatbotIdParam
    const { tenantUserId } = await resolveTenantContext(actorUserId, "admin")
    const ownedId = await requireOwnedChatbotId(tenantUserId, chatbotId)
    const entitlement = await getEntitlementForChatbot(ownedId)
    if (!entitlement.documentIngestion.enabled) {
      return next(new AppError(402, "Document uploads require the Crawl Plus plan or higher. Upgrade to upload documents."))
    }

    const caps = await loadIngestCaps(ownedId, entitlement.documentIngestion)

    const contentLength = Number(req.headers["content-length"])
    if (Number.isFinite(contentLength) && contentLength > caps.maxFileBytes + MULTIPART_OVERHEAD_MARGIN_BYTES) {
      return rejectAfterDraining(req, next, fileTooLargeError(caps.maxFileBytes))
    }

    const singleFile = multer({
      storage: multer.memoryStorage(),
      limits: { fileSize: caps.maxFileBytes, files: 1 },
    }).single("file")

    singleFile(req, res, (err: unknown) => {
      if (!err) return next()
      console.error("[uploadDocument] multer rejected the request:", err)
      if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
        return rejectAfterDraining(req, next, fileTooLargeError(caps.maxFileBytes))
      }
      return next(new AppError(400, "Couldn't process the uploaded file."))
    })
  } catch (err) {
    next(err)
  }
}
