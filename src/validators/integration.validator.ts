import { z } from "zod"

export const upsertIntegrationSchema = z.object({

  apiKey: z.string().trim().min(1).max(2000).optional(),
 
  apiBaseUrl: z
    .string()
    .trim()
    .max(500)
    .refine((value) => {
      try {
        const url = new URL(value)
        return url.protocol === "http:" || url.protocol === "https:"
      } catch {
        return false
      }
    }, "Enter a valid http or https URL.")
    .optional(),
})

export type UpsertIntegrationInput = z.infer<typeof upsertIntegrationSchema>
