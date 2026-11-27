import { z } from "zod"

export const signupSchema = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.string().trim().email(),
  password: z.string().min(8).max(72),
})

export const loginSchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(8).max(72),
})

// Optional now — the browser sends the refresh token via the
// chatmate360_refresh_token httpOnly cookie automatically (see
// src/lib/authCookies.ts); the body field is only a fallback for a
// non-browser client that isn't using cookies. The controller requires one
// of the two to actually be present (src/controllers/auth.controller.ts).
export const refreshSchema = z.object({
  refresh_token: z.string().min(10).optional(),
})

export const verifyEmailSchema = z.object({
  token: z.string().trim().min(20).max(200),
})

export const forgotPasswordSchema = z.object({
  email: z.string().trim().email(),
})

export const resetPasswordSchema = z.object({
  token: z.string().trim().min(20).max(200),
  password: z.string().min(8).max(72),
})

export const otpPurposeSchema = z.enum(["EMAIL_VERIFY", "ORDER_ACCESS", "SENSITIVE_ACTION"])

export const sendOtpSchema = z
  .object({
    email: z.string().trim().email(),
    purpose: otpPurposeSchema,
    chatbotId: z.string().guid().optional(),
    customerId: z.string().guid().optional(),
  })
  .superRefine((value, ctx) => {
    if ((value.purpose === "ORDER_ACCESS" || value.purpose === "SENSITIVE_ACTION") && !value.chatbotId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "chatbotId is required for this purpose",
        path: ["chatbotId"],
      })
    }
  })

export const verifyOtpSchema = z
  .object({
    email: z.string().trim().email(),
    purpose: otpPurposeSchema,
    code: z.string().trim().regex(/^\d{6}$/, "Enter the 6-digit code"),
    chatbotId: z.string().guid().optional(),
    customerId: z.string().guid().optional(),
  })
  .superRefine((value, ctx) => {
    if ((value.purpose === "ORDER_ACCESS" || value.purpose === "SENSITIVE_ACTION") && !value.chatbotId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "chatbotId is required for this purpose",
        path: ["chatbotId"],
      })
    }
  })

export const autoPurchaseSchema = z.object({
  enabled: z.boolean(),
  model: z.enum(["anthropic", "openai", "gemini"]).optional(),
})

export type SignupInput = z.infer<typeof signupSchema>
export type LoginInput = z.infer<typeof loginSchema>
export type RefreshInput = z.infer<typeof refreshSchema>
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>
export type SendOtpInput = z.infer<typeof sendOtpSchema>
export type VerifyOtpInput = z.infer<typeof verifyOtpSchema>
