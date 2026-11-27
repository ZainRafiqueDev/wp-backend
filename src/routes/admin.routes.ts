import { Router } from "express"

import {
  deleteAdminUser,
  getAdminAbuseFlags,
  getAdminBudget,
  getAdminMe,
  getAdminNotifications,
  getAdminReservationHealthStatus,
  getAdminStripeInboxStatus,
  getAdminRoutingEvents,
  getAdminUsagePlatformSummary,
  getAdminUserDetail,
  getAdminUsers,
  getAdminUserUsage,
  patchAdminAccount,
  patchAdminUserEntitlementOverride,
  postActivatePlan,
  postActivateUser,
  postAdminLogin,
  postAdminLogout,
  postCancelSubscription,
  postDeactivateUser,
  postReviewAbuseFlag,
  getAdminPlatformHealth,
  getAdminAiQuality,
  getAdminTenantUsage,
  getAdminProviderStatus,
  getAdminQueueDepth,
  getAdminOkfMetrics,
  getAdminPricing,
  postAdminPricing,
  postAdminPricingRecalculate,
  getAdminAlerts,
  patchAdminAlert,
  getAdminAccountMembers,
  getAdminAccountChatbots,
  getAdminWorkspaces,
  getAdminAdmins,
  postAdminAdmin,
  patchAdminAdmin,
  postAdminAdminRevokeSessions,
} from "../controllers/admin.controller.js"
import { rateLimitAdminAccountChange } from "../middleware/rateLimitAdminAccount.js"
import { rateLimitAdminLogin } from "../middleware/rateLimitAdminLogin.js"
import { requireAdminAuth, requireSuperAdmin } from "../middleware/requireAdminAuth.js"
import { requireDb } from "../middleware/requireDb.js"
import { validateBody, validateParams } from "../middleware/validate.js"
import {
  activatePlanSchema,
  adminLoginSchema,
  createAdminSchema,
  deleteUserSchema,
  idParamSchema,
  updateAdminAccountSchema,
  updateAdminSchema,
  updateTenantOverrideSchema,
} from "../validators/admin.validator.js"

export const adminRouter = Router()


adminRouter.post("/login", rateLimitAdminLogin, requireDb, validateBody(adminLoginSchema), postAdminLogin)
// CS-11: no requireAdminAuth, so an expired/revoked session can still clear
// its cookie. CSRF: the global requireTrustedOrigin covers the admin cookie.
adminRouter.post("/logout", requireDb, postAdminLogout)

adminRouter.get("/me", requireAdminAuth, requireDb, getAdminMe)
adminRouter.patch(
  "/account",
  requireAdminAuth,
  requireDb,
  rateLimitAdminAccountChange,
  validateBody(updateAdminAccountSchema),
  patchAdminAccount,
)

// SA-01: super-admin-only. requireAdminAuth reads the role from the database
// on every request; requireSuperAdmin answers 403 to a plain admin.
const superAdmin = [requireAdminAuth, requireSuperAdmin, requireDb] as const

adminRouter.get("/workspaces", ...superAdmin, getAdminWorkspaces)
adminRouter.get("/users/:id/members", ...superAdmin, validateParams(idParamSchema), getAdminAccountMembers)
adminRouter.get("/users/:id/chatbots", ...superAdmin, validateParams(idParamSchema), getAdminAccountChatbots)
adminRouter.get("/admins", ...superAdmin, getAdminAdmins)
adminRouter.post("/admins", ...superAdmin, validateBody(createAdminSchema), postAdminAdmin)
adminRouter.patch("/admins/:id", ...superAdmin, validateParams(idParamSchema), validateBody(updateAdminSchema), patchAdminAdmin)
adminRouter.post("/admins/:id/revoke-sessions", ...superAdmin, validateParams(idParamSchema), postAdminAdminRevokeSessions)

adminRouter.get("/users", requireAdminAuth, requireDb, getAdminUsers)
adminRouter.get("/users/:id", requireAdminAuth, requireDb, validateParams(idParamSchema), getAdminUserDetail)
adminRouter.post("/users/:id/deactivate", requireAdminAuth, requireDb, validateParams(idParamSchema), postDeactivateUser)
adminRouter.post("/users/:id/activate", requireAdminAuth, requireDb, validateParams(idParamSchema), postActivateUser)
// SA-02 (owner decision 16 Nov 2026): deleting accounts and changing plans or
// pricing are super-admin only. Plain admins keep read access and
// activate/deactivate.
adminRouter.post(
  "/users/:id/cancel-subscription",
  ...superAdmin,
  validateParams(idParamSchema),
  postCancelSubscription,
)
adminRouter.delete(
  "/users/:id",
  ...superAdmin,
  validateParams(idParamSchema),
  validateBody(deleteUserSchema),
  deleteAdminUser,
)
adminRouter.get("/users/:id/usage", requireAdminAuth, requireDb, validateParams(idParamSchema), getAdminUserUsage)

adminRouter.get("/usage/summary", requireAdminAuth, requireDb, getAdminUsagePlatformSummary)

adminRouter.get("/notifications", requireAdminAuth, requireDb, getAdminNotifications)

adminRouter.get("/abuse-flags", requireAdminAuth, requireDb, getAdminAbuseFlags)
adminRouter.post(
  "/abuse-flags/:id/review",
  requireAdminAuth,
  requireDb,
  validateParams(idParamSchema),
  postReviewAbuseFlag,
)

// Token/cost allocation admin oversight (tokenallocation.md §9).
adminRouter.get("/budget", requireAdminAuth, requireDb, getAdminBudget)
adminRouter.get("/routing-events", requireAdminAuth, requireDb, getAdminRoutingEvents)
adminRouter.get("/reservations/health", requireAdminAuth, requireDb, getAdminReservationHealthStatus)
adminRouter.get("/stripe-inbox", requireAdminAuth, requireDb, getAdminStripeInboxStatus)
adminRouter.patch(
  "/users/:id/entitlement-override",
  ...superAdmin,
  validateParams(idParamSchema),
  validateBody(updateTenantOverrideSchema),
  patchAdminUserEntitlementOverride,
)
adminRouter.post(
  "/users/:id/activate-plan",
  ...superAdmin,
  validateParams(idParamSchema),
  validateBody(activatePlanSchema),
  postActivatePlan,
)

adminRouter.get("/metrics/platform-health", requireAdminAuth, requireDb, getAdminPlatformHealth)
adminRouter.get("/metrics/ai-quality", requireAdminAuth, requireDb, getAdminAiQuality)
adminRouter.get("/metrics/tenant-usage", requireAdminAuth, requireDb, getAdminTenantUsage)
adminRouter.get("/metrics/provider-status", requireAdminAuth, requireDb, getAdminProviderStatus)
adminRouter.get("/metrics/queue-depth", requireAdminAuth, requireDb, getAdminQueueDepth)
adminRouter.get("/metrics/okf", requireAdminAuth, requireDb, getAdminOkfMetrics)
adminRouter.get("/pricing", requireAdminAuth, requireDb, getAdminPricing)
adminRouter.post("/pricing", ...superAdmin, postAdminPricing)
adminRouter.post("/pricing/recalculate", ...superAdmin, postAdminPricingRecalculate)
adminRouter.get("/alerts", requireAdminAuth, requireDb, getAdminAlerts)
adminRouter.patch("/alerts/:alertType", requireAdminAuth, requireDb, patchAdminAlert)
