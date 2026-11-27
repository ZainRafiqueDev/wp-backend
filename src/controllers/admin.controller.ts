import type { Request, Response } from "express"

import { AppError } from "../lib/errors.js"
import { asyncHandler } from "../middleware/asyncHandler.js"
import { clearAdminAuthCookie, getAdminToken, setAdminAuthCookie } from "../middleware/requireAdminAuth.js"
import { getAccountChatbots, getAccountMembers, listWorkspaces } from "../services/admin/adminAccountInspect.service.js"
import {
  createAdminAccount,
  listAdminAccounts,
  revokeAdminSessionsByActor,
  updateAdminAccountByActor,
} from "../services/admin/adminManagement.service.js"
import {
  activateUserPlan,
  adminLogin,
  adminLogout,
  cancelUserSubscription,
  deleteUser,
  getAdminPlatformBudgetStatus,
  getAdminReservationHealth,
  getAdminStripeInbox,
  getAdminRoutingActivity,
  getAdminSelf,
  getPlatformUsageSummary,
  getUserDetail,
  getUserUsageBreakdown,
  listAbuseFlags,
  listAdminNotifications,
  listUsers,
  markAbuseFlagReviewed,
  setUserActive,
  updateAdminAccount,
  updateTenantEntitlementOverride,
} from "../services/admin.service.js"
import type { RoutingReason } from "../services/routingEvents.service.js"
import type {
  ActivatePlanInput,
  AdminLoginInput,
  CreateAdminInput,
  DeleteUserInput,
  UpdateAdminAccountInput,
  UpdateAdminInput,
  UpdateTenantOverrideInput,
} from "../validators/admin.validator.js"

function idParam(req: Request): string {
  const value = req.params.id
  return Array.isArray(value) ? value[0] : value
}

export const postAdminLogin = asyncHandler(async (req: Request, res: Response) => {
  const { accessToken, admin } = await adminLogin(req.body as AdminLoginInput)
  // CS-11 contract change: the token is only set as the httpOnly admin
  // cookie and is no longer returned in the body (`accessToken` removed), so
  // page scripts never see it.
  setAdminAuthCookie(res, accessToken)
  res.status(200).json({ ok: true, admin })
})

// CS-11: server-side logout (see adminLogout) plus clearing the cookie.
export const postAdminLogout = asyncHandler(async (req: Request, res: Response) => {
  await adminLogout(getAdminToken(req))
  clearAdminAuthCookie(res)
  res.status(200).json({ ok: true })
})

// Also the admin UI's server-side route guard ("whoami"): every protected
// admin page calls this before rendering.
export const getAdminMe = asyncHandler(async (req: Request, res: Response) => {
  const admin = await getAdminSelf(getAdminToken(req))
  res.status(200).json({ ok: true, admin })
})

export const patchAdminAccount = asyncHandler(async (req: Request, res: Response) => {
  const { admin, accessToken } = await updateAdminAccount(getAdminToken(req), req.body as UpdateAdminAccountInput)
  if (accessToken) setAdminAuthCookie(res, accessToken)
  res.status(200).json({ ok: true, admin })
})

export const getAdminUsers = asyncHandler(async (req: Request, res: Response) => {
  const search = typeof req.query.search === "string" ? req.query.search : undefined
  const limit = typeof req.query.limit === "string" ? Number(req.query.limit) : undefined
  const offset = typeof req.query.offset === "string" ? Number(req.query.offset) : undefined
  const { users, totalCount } = await listUsers(getAdminToken(req), search, limit, offset)
  res.set("X-Total-Count", String(totalCount))
  res.status(200).json({ ok: true, users, totalCount })
})

export const postDeactivateUser = asyncHandler(async (req: Request, res: Response) => {
  await setUserActive(getAdminToken(req), idParam(req), false)
  res.status(200).json({ ok: true })
})

export const postActivateUser = asyncHandler(async (req: Request, res: Response) => {
  await setUserActive(getAdminToken(req), idParam(req), true)
  res.status(200).json({ ok: true })
})

export const postCancelSubscription = asyncHandler(async (req: Request, res: Response) => {
  const result = await cancelUserSubscription(getAdminToken(req), idParam(req))
  res.status(200).json({ ok: true, ...result })
})

export const deleteAdminUser = asyncHandler(async (req: Request, res: Response) => {
  const { confirm } = req.body as DeleteUserInput
  await deleteUser(getAdminToken(req), idParam(req), confirm === true)
  res.status(200).json({ ok: true })
})

export const getAdminUserDetail = asyncHandler(async (req: Request, res: Response) => {
  const user = await getUserDetail(getAdminToken(req), idParam(req))
  res.status(200).json({ ok: true, user })
})

export const getAdminUserUsage = asyncHandler(async (req: Request, res: Response) => {
  const usage = await getUserUsageBreakdown(getAdminToken(req), idParam(req))
  res.status(200).json({ ok: true, usage })
})

export const getAdminUsagePlatformSummary = asyncHandler(async (req: Request, res: Response) => {
  const summary = await getPlatformUsageSummary(getAdminToken(req))
  res.status(200).json({ ok: true, summary })
})

export const getAdminNotifications = asyncHandler(async (req: Request, res: Response) => {
  const notifications = await listAdminNotifications(getAdminToken(req))
  res.status(200).json({ ok: true, notifications })
})

export const getAdminAbuseFlags = asyncHandler(async (req: Request, res: Response) => {
  const flags = await listAbuseFlags(getAdminToken(req))
  res.status(200).json({ ok: true, flags })
})

export const postReviewAbuseFlag = asyncHandler(async (req: Request, res: Response) => {
  await markAbuseFlagReviewed(getAdminToken(req), idParam(req))
  res.status(200).json({ ok: true })
})

export const getAdminBudget = asyncHandler(async (req: Request, res: Response) => {
  const budget = await getAdminPlatformBudgetStatus(getAdminToken(req))
  res.status(200).json({ ok: true, budget })
})

export const getAdminRoutingEvents = asyncHandler(async (req: Request, res: Response) => {
  const chatbotId = typeof req.query.chatbotId === "string" ? req.query.chatbotId : undefined
  const reason = typeof req.query.reason === "string" ? (req.query.reason as RoutingReason) : undefined
  const limit = typeof req.query.limit === "string" ? Number(req.query.limit) : undefined
  const events = await getAdminRoutingActivity(getAdminToken(req), { chatbotId, reason, limit })
  res.status(200).json({ ok: true, events })
})

export const getAdminReservationHealthStatus = asyncHandler(async (req: Request, res: Response) => {
  const health = await getAdminReservationHealth(getAdminToken(req))
  res.status(200).json({ ok: true, health })
})

export const getAdminStripeInboxStatus = asyncHandler(async (req: Request, res: Response) => {
  const limit = typeof req.query.limit === "string" ? Number(req.query.limit) : undefined
  const offset = typeof req.query.offset === "string" ? Number(req.query.offset) : undefined
  const inbox = await getAdminStripeInbox(getAdminToken(req), {
    status: typeof req.query.status === "string" ? req.query.status : undefined,
    type: typeof req.query.type === "string" ? req.query.type : undefined,
    customer: typeof req.query.customer === "string" ? req.query.customer : undefined,
    limit: Number.isFinite(limit) ? limit : undefined,
    offset: Number.isFinite(offset) ? offset : undefined,
  })
  res.status(200).json({ ok: true, ...inbox })
})

export const patchAdminUserEntitlementOverride = asyncHandler(async (req: Request, res: Response) => {
  const override = await updateTenantEntitlementOverride(getAdminToken(req), idParam(req), req.body as UpdateTenantOverrideInput)
  res.status(200).json({ ok: true, override })
})

export const postActivatePlan = asyncHandler(async (req: Request, res: Response) => {
  const activation = await activateUserPlan(getAdminToken(req), idParam(req), req.body as ActivatePlanInput)
  res.status(200).json({ ok: true, activation })
})

export const getAdminPlatformHealth = asyncHandler(async (_req: Request, res: Response) => {
  const { getPlatformHealth } = await import("../services/observability.service.js")
  res.status(200).json({ ok: true, ...(await getPlatformHealth()) })
})

export const getAdminAiQuality = asyncHandler(async (req: Request, res: Response) => {
  const { getAiQualityMetrics } = await import("../services/observability.service.js")
  const days = typeof req.query.days === "string" ? Number(req.query.days) : 7
  const chatbotId = typeof req.query.chatbot_id === "string" ? req.query.chatbot_id : undefined
  res.status(200).json({ ok: true, ...(await getAiQualityMetrics(Number.isFinite(days) ? days : 7, chatbotId)) })
})

export const getAdminTenantUsage = asyncHandler(async (req: Request, res: Response) => {
  const { getTenantUsage } = await import("../services/observability.service.js")
  const month = typeof req.query.month === "string" ? req.query.month : new Date().toISOString().slice(0, 7)
  const limit = typeof req.query.limit === "string" ? Number(req.query.limit) : 10
  res.status(200).json({ ok: true, ...(await getTenantUsage(month, Number.isFinite(limit) ? limit : 10)) })
})

export const getAdminProviderStatus = asyncHandler(async (_req: Request, res: Response) => {
  const { getProviderStatus } = await import("../services/observability.service.js")
  res.status(200).json({ ok: true, ...(await getProviderStatus()) })
})

export const getAdminQueueDepth = asyncHandler(async (_req: Request, res: Response) => {
  const { getQueueDepth } = await import("../services/observability.service.js")
  res.status(200).json({ ok: true, ...(await getQueueDepth()) })
})

export const getAdminOkfMetrics = asyncHandler(async (req: Request, res: Response) => {
  const { getOkfMetrics } = await import("../services/observability.service.js")
  const days = typeof req.query.days === "string" ? Number(req.query.days) : 7
  res.status(200).json({ ok: true, ...(await getOkfMetrics(Number.isFinite(days) ? days : 7)) })
})

export const getAdminPricing = asyncHandler(async (_req: Request, res: Response) => {
  const { listPricingConfigs } = await import("../services/pricing.service.js")
  res.status(200).json({ ok: true, configs: await listPricingConfigs(true) })
})

export const postAdminPricing = asyncHandler(async (req: Request, res: Response) => {
  const { savePricingConfig } = await import("../services/pricing.service.js")
  const config = await savePricingConfig(req.body)
  res.status(200).json({ ok: true, config })
})

export const postAdminPricingRecalculate = asyncHandler(async (req: Request, res: Response) => {
  const { previewRecalculateAll, applyRecalculateAll } = await import("../services/pricing.service.js")
  const apply = req.body?.apply === true
  if (apply) {
    res.status(200).json({ ok: true, configs: await applyRecalculateAll(req.body ?? {}) })
    return
  }
  res.status(200).json({ ok: true, preview: await previewRecalculateAll(req.body ?? {}) })
})

export const getAdminAlerts = asyncHandler(async (_req: Request, res: Response) => {
  const { listAlertConfigs } = await import("../services/alerts.service.js")
  res.status(200).json({ ok: true, alerts: await listAlertConfigs() })
})

export const patchAdminAlert = asyncHandler(async (req: Request, res: Response) => {
  const { setAlertEnabled } = await import("../services/alerts.service.js")
  const alertType = paramAlertType(req)
  await setAlertEnabled(alertType, req.body?.enabled === true)
  res.status(200).json({ ok: true })
})

function paramAlertType(req: Request) {
  const value = req.params.alertType
  return (Array.isArray(value) ? value[0] : value) as import("../services/alerts.service.js").AlertType
}

// ---------------------------------------------------------------------------
// SA-01: super-admin-only endpoints. Routes put requireAdminAuth +
// requireSuperAdmin in front of all of these, so req.adminUserId is a live,
// active super admin for this request.
// ---------------------------------------------------------------------------

function actorId(req: Request): string {
  if (!req.adminUserId) throw new AppError(401, "Admin sign-in required.")
  return req.adminUserId
}

function numberQuery(req: Request, name: string): number | undefined {
  const raw = req.query[name]
  if (typeof raw !== "string") return undefined
  const value = Number(raw)
  return Number.isFinite(value) ? value : undefined
}

export const getAdminAccountMembers = asyncHandler(async (req: Request, res: Response) => {
  const result = await getAccountMembers(actorId(req), idParam(req), numberQuery(req, "limit"), numberQuery(req, "offset"))
  res.status(200).json({ ok: true, ...result })
})

export const getAdminAccountChatbots = asyncHandler(async (req: Request, res: Response) => {
  const result = await getAccountChatbots(actorId(req), idParam(req), numberQuery(req, "limit"), numberQuery(req, "offset"))
  res.status(200).json({ ok: true, ...result })
})

export const getAdminWorkspaces = asyncHandler(async (req: Request, res: Response) => {
  const search = typeof req.query.search === "string" ? req.query.search : undefined
  const result = await listWorkspaces(actorId(req), search, numberQuery(req, "limit"), numberQuery(req, "offset"))
  res.status(200).json({ ok: true, ...result })
})

export const getAdminAdmins = asyncHandler(async (req: Request, res: Response) => {
  const result = await listAdminAccounts(actorId(req), numberQuery(req, "limit"), numberQuery(req, "offset"))
  res.status(200).json({ ok: true, ...result })
})

export const postAdminAdmin = asyncHandler(async (req: Request, res: Response) => {
  const admin = await createAdminAccount(actorId(req), req.body as CreateAdminInput)
  res.status(201).json({ ok: true, admin })
})

export const patchAdminAdmin = asyncHandler(async (req: Request, res: Response) => {
  const admin = await updateAdminAccountByActor(actorId(req), idParam(req), req.body as UpdateAdminInput)
  res.status(200).json({ ok: true, admin })
})

export const postAdminAdminRevokeSessions = asyncHandler(async (req: Request, res: Response) => {
  await revokeAdminSessionsByActor(actorId(req), idParam(req))
  res.status(200).json({ ok: true })
})
