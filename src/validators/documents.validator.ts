import { z } from "zod"

export const documentIdParamSchema = z.object({
  chatbotId: z.string().guid(),
  id: z.string().guid(),
})
