import { z } from "zod"

export const contactSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().email(),
  message: z.string().trim().min(1).max(4000),
})

export type ContactInput = z.infer<typeof contactSchema>
