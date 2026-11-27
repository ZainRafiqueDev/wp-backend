import { z } from "zod"

export const attachmentIdParamSchema = z.object({
  chatbotId: z.string().guid(),
  attachmentId: z.string().guid(),
})

// Multipart text fields alongside the file — multer puts these on req.body
// as plain strings, so this validates the parsed body after multer runs,
// same ordering uploadDocument.ts's route already uses for the file field.
export const uploadAttachmentBodySchema = z.object({
  // CS-04: the server-issued session token from the chat response is what
  // binds an upload to a conversation. sessionId (client-chosen) is still
  // accepted so older widgets get a clear 400 from the service, not a schema
  // error, but it is never used as a key.
  sessionId: z.string().trim().min(1).max(200).optional(),
  sessionToken: z.string().min(1).max(4096).optional(),
  customerToken: z.string().min(1).max(4096).optional(),
  // Must match the session's verified customer if sent; never trusted alone.
  customerId: z.string().guid().optional(),
  bookingId: z.string().guid().optional(),
})
export type UploadAttachmentBodyInput = z.infer<typeof uploadAttachmentBodySchema>
