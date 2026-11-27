import type { Request, Response } from "express"

import { asyncHandler } from "../middleware/asyncHandler.js"
import { getBearerToken } from "../middleware/requireAuth.js"
import { AppError } from "../lib/errors.js"
import { deleteDocument, getDocumentStatus, listDocuments, retryDocument, uploadDocument } from "../services/documentIngestion.service.js"

function param(req: Request, name: string): string {
  const value = req.params[name]
  return Array.isArray(value) ? value[0] : value
}

export const getDocuments = asyncHandler(async (req: Request, res: Response) => {
  const { documents, caps } = await listDocuments(getBearerToken(req), param(req, "chatbotId"))
  res.status(200).json({ ok: true, documents, caps })
})

export const postDocument = asyncHandler(async (req: Request, res: Response) => {
  const file = req.file
  if (!file) {
    console.error("[documents.controller] postDocument: no file on request — multer field name mismatch or empty upload")
    throw new AppError(400, "No file was uploaded. Attach a file under the \"file\" field.")
  }
  console.log(`[documents.controller] postDocument: chatbotId=${param(req, "chatbotId")} fileName="${file.originalname}" size=${file.size}`)
  // Caps on count/bytes throw 409 before persist. Async ingest returns 202
  // with status=processing; the worker embeds. Sync rollback (flag) still
  // returns 201 after inline process.
  const { document, accepted } = await uploadDocument(getBearerToken(req), param(req, "chatbotId"), file)
  res.status(accepted ? 202 : 201).json({ ok: true, document, job_id: document.id })
})

export const getDocumentIngestStatus = asyncHandler(async (req: Request, res: Response) => {
  const status = await getDocumentStatus(getBearerToken(req), param(req, "chatbotId"), param(req, "id"))
  res.status(200).json({ ok: true, ...status })
})

export const retryFailedDocument = asyncHandler(async (req: Request, res: Response) => {
  const document = await retryDocument(getBearerToken(req), param(req, "chatbotId"), param(req, "id"))
  res.status(202).json({ ok: true, document })
})

export const removeDocument = asyncHandler(async (req: Request, res: Response) => {
  await deleteDocument(getBearerToken(req), param(req, "chatbotId"), param(req, "id"))
  res.status(204).send()
})
