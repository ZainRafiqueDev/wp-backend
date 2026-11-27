import { z } from "zod"

import { OKF_TYPES } from "../lib/okf.js"
import { httpUrl } from "./httpUrl.js"

export const okfConceptParamSchema = z.object({
  chatbotId: z.string().guid(),
  id: z.string().guid(),
})

export const okfAuditRestoreSchema = z.object({
  auditId: z.string().guid(),
})

export const createOkfConceptSchema = z.object({
  type: z.enum(OKF_TYPES),
  title: z.string().trim().min(1).max(100),
  description: z.string().trim().max(500).optional().nullable(),
  tags: z.array(z.string().trim().min(1).max(40)).max(12).optional(),
  resourceUrl: httpUrl().optional().nullable().or(z.literal("")),
  bodyMd: z.string().trim().min(1).max(10_000),
})

export const updateOkfConceptSchema = createOkfConceptSchema.partial().extend({
  bodyMd: z.string().trim().min(1).max(10_000).optional(),
})

export type CreateOkfConceptInput = z.infer<typeof createOkfConceptSchema>
export type UpdateOkfConceptInput = z.infer<typeof updateOkfConceptSchema>
