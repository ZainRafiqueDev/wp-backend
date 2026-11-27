import { z } from "zod"

export const createLiveDataSchema = z.object({
  key: z.string().trim().min(1).max(200),
  value: z.string().trim().min(1).max(2000),
})

export const updateLiveDataSchema = z.object({
  key: z.string().trim().min(1).max(200).optional(),
  value: z.string().trim().min(1).max(2000),
})


export const liveDataIdParamSchema = z.object({
  chatbotId: z.string().guid(),
  id: z.string().guid(),
})

export type CreateLiveDataInput = z.infer<typeof createLiveDataSchema>
export type UpdateLiveDataInput = z.infer<typeof updateLiveDataSchema>
