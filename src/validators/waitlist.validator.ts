import { z } from "zod"

export const waitlistSchema = z.object({
  email: z.string().trim().email(),
})

export type WaitlistInput = z.infer<typeof waitlistSchema>
