import { z } from "zod"

export const trialSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().email(),
  company: z.string().trim().max(160).optional(),
  plan: z.string().trim().max(40).optional(),
})

export type TrialInput = z.infer<typeof trialSchema>
