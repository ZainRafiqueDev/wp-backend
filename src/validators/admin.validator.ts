import { z } from "zod"

export const adminLoginSchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(1),
})
export type AdminLoginInput = z.infer<typeof adminLoginSchema>


export const idParamSchema = z.object({ id: z.string().guid() })
export const deleteUserSchema = z.object({ confirm: z.literal(true) })
export type DeleteUserInput = z.infer<typeof deleteUserSchema>

// SA-01: one password policy for every admin password (self-service change,
// admin creation, seed script). At least 12 characters, not blank, and at
// most 72 UTF-8 bytes because bcrypt silently ignores anything after that.
export const ADMIN_PASSWORD_MIN_LENGTH = 12
export const ADMIN_PASSWORD_MAX_BYTES = 72

export function adminPasswordProblem(password: string): string | null {
  if (password.length < ADMIN_PASSWORD_MIN_LENGTH) {
    return `Password must be at least ${ADMIN_PASSWORD_MIN_LENGTH} characters.`
  }
  if (!password.trim()) return "Password must not be blank."
  if (Buffer.byteLength(password, "utf8") > ADMIN_PASSWORD_MAX_BYTES) {
    return `Password must be at most ${ADMIN_PASSWORD_MAX_BYTES} bytes.`
  }
  return null
}

export const adminPasswordSchema = z.string().superRefine((value, ctx) => {
  const problem = adminPasswordProblem(value)
  if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem })
})

const adminEmailSchema = z.string().trim().toLowerCase().email().max(320)

export const updateAdminAccountSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newEmail: adminEmailSchema.optional(),
  newPassword: adminPasswordSchema.optional(),
})
export type UpdateAdminAccountInput = z.infer<typeof updateAdminAccountSchema>

export const ADMIN_ROLES = ["super_admin", "admin"] as const
export type AdminRole = (typeof ADMIN_ROLES)[number]

export const createAdminSchema = z.object({
  email: adminEmailSchema,
  name: z.string().trim().min(1).max(120),
  password: adminPasswordSchema,
  role: z.enum(ADMIN_ROLES).default("admin"),
})
export type CreateAdminInput = z.infer<typeof createAdminSchema>

export const updateAdminSchema = z
  .object({
    role: z.enum(ADMIN_ROLES).optional(),
    name: z.string().trim().min(1).max(120).optional(),
    isActive: z.boolean().optional(),
  })
  .strict()
  .refine((value) => value.role !== undefined || value.name !== undefined || value.isActive !== undefined, {
    message: "Nothing to update.",
  })
export type UpdateAdminInput = z.infer<typeof updateAdminSchema>

// Every field independently optional — an admin can set just one custom cap
// without having to also restate the others (see billing.service.ts's
// applyEntitlementOverrides, which treats each column the same way).
export const updateTenantOverrideSchema = z
  .object({
    customDailyCapUsd: z.number().positive().nullable().optional(),
    customWeeklyCapUsd: z.number().positive().nullable().optional(),
    customMonthlyCapUsd: z.number().positive().nullable().optional(),
    cashCollectedUsd: z.number().positive().optional(),
    customLimitAction: z.enum(["BLOCK", "ROUTE_TO_CHEAPER_MODEL", "USE_OVERAGE", "ADMIN_OVERRIDE"]).nullable().optional(),
    customAllowedModels: z.array(z.enum(["anthropic", "openai", "gemini"])).min(1).nullable().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.customMonthlyCapUsd != null && (value.cashCollectedUsd == null || value.cashCollectedUsd <= 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["cashCollectedUsd"],
        message: "cashCollectedUsd is required when setting a monthly credit grant.",
      })
    }
  })
export type UpdateTenantOverrideInput = z.infer<typeof updateTenantOverrideSchema>

const modelKeySchema = z.enum(["anthropic", "openai", "gemini"])

// WP-2.6. Blueprint body is { plan, monthlyCreditUsd, allowedModels }.
// cashCollectedUsd is required by the WP-1.1 grant < cash invariant.
// overrideReason is required only when monthlyCreditUsd exceeds safe credits.
export const activatePlanSchema = z.object({
  plan: z.enum(["full_custom", "crawl_plus"]),
  monthlyCreditUsd: z.number().positive(),
  allowedModels: z.array(modelKeySchema).min(1),
  cashCollectedUsd: z.number().positive(),
  overrideReason: z.string().trim().max(2000).optional(),
})
export type ActivatePlanInput = z.infer<typeof activatePlanSchema>
