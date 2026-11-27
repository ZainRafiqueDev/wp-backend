import { z } from "zod"

export const demoChatSchema = z.object({
  message: z.string().trim().min(1).max(500),
})

export type DemoChatInput = z.infer<typeof demoChatSchema>
