import type { Request, Response } from "express"

import { asyncHandler } from "../middleware/asyncHandler.js"
import { getBearerToken } from "../middleware/requireAuth.js"
import {
  approveConcept,
  createConcept,
  deactivateConcept,
  exportBundle,
  getConcept,
  getIndex,
  listAudit,
  listConcepts,
  overview,
  restoreConcept,
  updateConcept,
} from "../services/okf.service.js"
import type { CreateOkfConceptInput, UpdateOkfConceptInput } from "../validators/okf.validator.js"
import { isOkfType, type OKFType } from "../lib/okf.js"

function param(req: Request, name: string): string {
  const value = req.params[name]
  return Array.isArray(value) ? value[0] : value
}

function queryString(req: Request, name: string): string | undefined {
  const value = req.query[name]
  return typeof value === "string" ? value : undefined
}

export const postOkfConcept = asyncHandler(async (req: Request, res: Response) => {
  const body = req.body as CreateOkfConceptInput
  const concept = await createConcept(getBearerToken(req), param(req, "chatbotId"), {
    type: body.type,
    title: body.title,
    description: body.description,
    tags: body.tags,
    resourceUrl: body.resourceUrl || null,
    bodyMd: body.bodyMd,
  })
  res.status(201).json({ ok: true, concept })
})

export const getOkfConcepts = asyncHandler(async (req: Request, res: Response) => {
  const typeRaw = queryString(req, "type")
  const statusRaw = queryString(req, "status")
  const type = typeRaw && isOkfType(typeRaw) ? typeRaw : undefined
  const status =
    statusRaw === "active" || statusRaw === "pending" || statusRaw === "inactive" ? statusRaw : undefined
  const concepts = await listConcepts(getBearerToken(req), param(req, "chatbotId"), {
    type: type as OKFType | undefined,
    status,
    q: queryString(req, "q"),
  })
  res.status(200).json({ ok: true, concepts })
})

export const getOkfConcept = asyncHandler(async (req: Request, res: Response) => {
  const concept = await getConcept(getBearerToken(req), param(req, "chatbotId"), param(req, "id"))
  res.status(200).json({ ok: true, concept })
})

export const putOkfConcept = asyncHandler(async (req: Request, res: Response) => {
  const body = req.body as UpdateOkfConceptInput
  const concept = await updateConcept(getBearerToken(req), param(req, "chatbotId"), param(req, "id"), {
    type: body.type,
    title: body.title,
    description: body.description,
    tags: body.tags,
    resourceUrl: body.resourceUrl || null,
    bodyMd: body.bodyMd,
  })
  res.status(200).json({ ok: true, concept })
})

export const postApproveOkfConcept = asyncHandler(async (req: Request, res: Response) => {
  const concept = await approveConcept(getBearerToken(req), param(req, "chatbotId"), param(req, "id"))
  res.status(200).json({ ok: true, concept })
})

export const deleteOkfConcept = asyncHandler(async (req: Request, res: Response) => {
  await deactivateConcept(getBearerToken(req), param(req, "chatbotId"), param(req, "id"))
  res.status(204).send()
})

export const getOkfIndex = asyncHandler(async (req: Request, res: Response) => {
  const index = await getIndex(getBearerToken(req), param(req, "chatbotId"))
  res.status(200).json({ ok: true, ...index })
})

export const getOkfExport = asyncHandler(async (req: Request, res: Response) => {
  const bundle = await exportBundle(getBearerToken(req), param(req, "chatbotId"))
  res.setHeader("Content-Type", "application/zip")
  res.setHeader("Content-Disposition", `attachment; filename="${bundle.filename}"`)
  res.status(200).send(bundle.bytes)
})

export const getOkfAudit = asyncHandler(async (req: Request, res: Response) => {
  const entries = await listAudit(getBearerToken(req), param(req, "chatbotId"), param(req, "id"))
  res.status(200).json({ ok: true, entries })
})

export const postRestoreOkfConcept = asyncHandler(async (req: Request, res: Response) => {
  const auditId = (req.body as { auditId: string }).auditId
  const concept = await restoreConcept(getBearerToken(req), param(req, "chatbotId"), param(req, "id"), auditId)
  res.status(200).json({ ok: true, concept })
})

export const getOkfOverview = asyncHandler(async (req: Request, res: Response) => {
  const data = await overview(getBearerToken(req), param(req, "chatbotId"))
  res.status(200).json({ ok: true, ...data })
})
