import { z } from "zod"

import { httpUrl } from "./httpUrl.js"

export const connectWooCommerceSchema = z.object({
  storeUrl: httpUrl(),
  consumerKey: z.string().trim().min(1).max(500),
  consumerSecret: z.string().trim().min(1).max(500),
  webhookSecret: z.string().trim().min(1).max(500),
})

export type ConnectWooCommerceInput = z.infer<typeof connectWooCommerceSchema>
