import { z } from "zod"

export const booklyAdminChatSchema = z.object({
  message: z.string().trim().min(1).max(2000),
  conversationId: z.string().trim().min(1).max(200).optional(),
 
  booklyAdminToken: z.string().trim().min(1).max(4000),
})

export type BooklyAdminChatInput = z.infer<typeof booklyAdminChatSchema>
