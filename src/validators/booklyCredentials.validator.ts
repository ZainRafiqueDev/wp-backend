import { z } from "zod"

import { httpUrl } from "./httpUrl.js"

export const connectBooklySchema = z.object({
  baseUrl: httpUrl(),
  resourceId: z.string().trim().min(1).max(200),
  resourceLabel: z.string().trim().max(200).optional().default(""),
  apiKey: z.string().trim().min(1).max(500),
})

export type ConnectBooklyInput = z.infer<typeof connectBooklySchema>
