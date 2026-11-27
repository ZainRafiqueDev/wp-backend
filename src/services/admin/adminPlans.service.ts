import { env, hasStripe, requireCreditGrantingEnabled } from "../../env.js"
import { adminActivatedCustomerId, incrementAdminMetric } from "../../lib/adminMetrics.js"
import { AppError } from "../../lib/errors.js"
import { log } from "../../lib/logger.js"
import type { LimitAction, ModelKey } from "../../lib/plans.js"
import {
  assertGrantLessThanCash,
  CreditGrantInvariantError,
  creditGrantMetricFields,
  safeCreditsFromCash,
  usdGreaterThan,
} from "../../lib/planEconomics.js"
import { stripeClient } from "../../lib/stripe.js"
import type { ActivatePlanInput, UpdateTenantOverrideInput } from "../../validators/admin.validator.js"
import { getEntitlementForUser, isEntitledStatus } from "../billing.service.js"
import { createNotification } from "../notification.service.js"
import { recordRoutingEvent } from "../routingEvents.service.js"
import { requireAdminUserId } from "./adminAuth.service.js"
import { logAdminAction, requireDbPool } from "./shared.js"

function isStripeResourceMissing(err: unknown): boolean {
  const e = err as { code?: string; statusCode?: number } | null
  return Boolean(e && (e.code === "resource_missing" || e.statusCode === 404))
}

/**
 * CS-13 (B06-006): cancel a Stripe subscription or fail the admin action.
 * The local row must never say "canceled" (or be detached / deleted) while
 * Stripe keeps billing the customer, so any Stripe error other than "this
 * subscription no longer exists" aborts before anything local changes.
 */
export async function cancelStripeSubscriptionOrThrow(
  subscriptionId: string,
  context: { targetUserId: string; action: string },
): Promise<void> {
  try {
    await stripeClient().subscriptions.cancel(subscriptionId)
  } catch (err) {
    if (isStripeResourceMissing(err)) {
      log().info({ ...context }, "stripe subscription already gone, nothing to cancel")
      return
    }
    // Cancelling an already-canceled subscription is an error at Stripe;
    // confirm Stripe's own state and treat "already canceled" as success.
    let current: { status?: string } | null | undefined = null
    try {
      current = await stripeClient().subscriptions.retrieve(subscriptionId)
    } catch {
      current = null
    }
    if (current && (current.status === "canceled" || current.status === "incomplete_expired")) {
      log().info({ ...context, status: current.status }, "stripe subscription was already canceled")
      return
    }
    log().error(
      { ...context, err: err instanceof Error ? err.message : String(err) },
      "stripe subscription cancel failed, admin action aborted without local changes",
    )
    throw new AppError(502, "Stripe did not confirm the subscription cancellation, so nothing was changed. Try again.")
  }
}

// Admin-initiated cancellation. Calls Stripe directly (belt) AND writes the
// local status (suspenders) rather than waiting on the webhook — unlike
// checkout activation (where only the webhook is trusted, since a client
// could otherwise self-grant access), a downgrade is safe to apply
// optimistically: worst case the webhook redundantly re-applies the same
// state a moment later.
export async function cancelUserSubscription(accessToken: string, targetUserId: string): Promise<{ plan: string }> {
  const adminUserId = requireAdminUserId(accessToken)
  const db = requireDbPool()

  const { rows } = await db.query<{
    stripe_subscription_id: string | null
    plan: string
    status: string
    email: string
  }>(
    `select s.stripe_subscription_id, s.plan, s.status, u.email
     from subscriptions s join users u on u.id = s.user_id
     where s.user_id = $1`,
    [targetUserId],
  )
  const row = rows[0]
  if (!row || !isEntitledStatus(row.status)) {
    throw new AppError(400, "This account has no active paid subscription to cancel.")
  }

  if (row.stripe_subscription_id && hasStripe) {
    await cancelStripeSubscriptionOrThrow(row.stripe_subscription_id, { targetUserId, action: "cancel_subscription" })
  }

  await db.query("update subscriptions set status = 'canceled', updated_at = now() where user_id = $1", [targetUserId])

  await createNotification({
    userId: targetUserId,
    type: "subscription",
    title: "Subscription canceled",
    body: "Your paid plan was canceled by an administrator. Paid features are no longer active.",
    emailTo: row.email,
  })

  await logAdminAction(adminUserId, "cancel_subscription", targetUserId, { previousPlan: row.plan })
  return { plan: row.plan }
}

export interface ActivatedPlan {
  plan: "full_custom"
  status: "active"
  monthlyCreditUsd: number
  allowedModels: ModelKey[]
  cashCollectedUsd: number
  safeCreditsUsd: number
  exceededSafeCredits: boolean
  grantCustomActions: false
  currentPeriodEnd: string
  activatedAt: string
}

// WP-2.6. After meeting + payment, a senior writes the same entitlement
// shape Stripe uses for Crawl Plus (subscriptions.plan/status + custom
// monthly cap + allowed models). Custom Actions stay Crawl Plus-only.
export async function activateUserPlan(
  accessToken: string,
  targetUserId: string,
  input: ActivatePlanInput,
): Promise<ActivatedPlan> {
  const adminUserId = requireAdminUserId(accessToken)
  if (input.plan !== "full_custom") {
    throw new AppError(
      400,
      "This endpoint activates Full Custom after meeting and payment. Use Stripe Checkout for Crawl Plus.",
    )
  }

  requireCreditGrantingEnabled()

  try {
    assertGrantLessThanCash(input.monthlyCreditUsd, input.cashCollectedUsd)
  } catch (err) {
    if (err instanceof CreditGrantInvariantError) throw new AppError(400, err.message)
    throw err
  }

  const safeCreditsUsd = safeCreditsFromCash(input.cashCollectedUsd, env.adminPlanAiBudgetRatio)
  const exceededSafeCredits = usdGreaterThan(input.monthlyCreditUsd, safeCreditsUsd)
  const overrideReason = input.overrideReason?.trim() ?? ""
  if (exceededSafeCredits && overrideReason.length < env.adminPlanOverrideReasonMinLength) {
    throw new AppError(
      400,
      `monthlyCreditUsd ${input.monthlyCreditUsd} exceeds computed safe credits ${safeCreditsUsd}. Provide overrideReason (at least ${env.adminPlanOverrideReasonMinLength} characters).`,
    )
  }

  const db = requireDbPool()
  const { rows: userRows } = await db.query<{ email: string }>("select email from users where id = $1", [targetUserId])
  if (!userRows[0]) throw new AppError(404, "User not found.")

  const { rows: existingRows } = await db.query<{
    stripe_subscription_id: string | null
    plan: string
    status: string
  }>("select stripe_subscription_id, plan, status from subscriptions where user_id = $1", [targetUserId])
  const existing = existingRows[0]

  // Even when the local row says canceled, make sure Stripe agrees: the
  // local status can be stale (missed webhook, earlier failed cancel).
  if (existing?.stripe_subscription_id && hasStripe) {
    await cancelStripeSubscriptionOrThrow(existing.stripe_subscription_id, { targetUserId, action: "activate_plan" })
  }

  const periodEnd = new Date(Date.now() + env.adminPlanPeriodDays * 24 * 60 * 60 * 1000)
  const activatedAt = new Date()
  const customerId = adminActivatedCustomerId(targetUserId)

  await db.query(
    `insert into subscriptions (
       user_id, stripe_customer_id, stripe_subscription_id, plan, status, current_period_end,
       custom_monthly_cap_usd, custom_allowed_models, activated_by, activated_at
     ) values ($1, $2, null, 'full_custom', 'active', $3, $4, $5::jsonb, $6, $7)
     on conflict (user_id) do update set
       -- CS-13 (B06-006): keep the real Stripe customer id so later events
       -- and refunds for that customer still find this row; the synthetic
       -- id is only for users who never had one.
       stripe_customer_id = subscriptions.stripe_customer_id,
       stripe_subscription_id = null,
       plan = excluded.plan,
       status = excluded.status,
       current_period_end = excluded.current_period_end,
       custom_monthly_cap_usd = excluded.custom_monthly_cap_usd,
       custom_allowed_models = excluded.custom_allowed_models,
       activated_by = excluded.activated_by,
       activated_at = excluded.activated_at,
       updated_at = now()`,
    [
      targetUserId,
      customerId,
      periodEnd,
      input.monthlyCreditUsd,
      JSON.stringify(input.allowedModels),
      adminUserId,
      activatedAt,
    ],
  )

  await db.query("update users set trial_deactivated = false where id = $1 and trial_deactivated = true", [targetUserId])

  const entitlement = await getEntitlementForUser(targetUserId)
  if (!entitlement.active || entitlement.plan !== "full_custom") {
    throw new AppError(500, "Full Custom entitlement was not written.")
  }

  const detail = {
    plan: "full_custom" as const,
    monthlyCreditUsd: input.monthlyCreditUsd,
    allowedModels: input.allowedModels,
    cashCollectedUsd: input.cashCollectedUsd,
    safeCreditsUsd,
    exceededSafeCredits,
    overrideReason: exceededSafeCredits ? overrideReason : undefined,
    previousPlan: existing?.plan ?? "free",
    grantCustomActions: false as const,
    ...creditGrantMetricFields(input.monthlyCreditUsd, input.cashCollectedUsd),
  }

  await logAdminAction(adminUserId, "activate_plan", targetUserId, detail)
  await incrementAdminMetric("admin.plan_activated", {
    adminUserId,
    targetUserId,
    plan: "full_custom",
    monthlyCreditUsd: input.monthlyCreditUsd,
    cashCollectedUsd: input.cashCollectedUsd,
    exceededSafeCredits,
    grantCustomActions: false,
  })

  await createNotification({
    userId: targetUserId,
    type: "subscription",
    title: "Full Custom plan activated",
    body: "Your Full Custom plan is now active. Custom Actions remain a Crawl Plus feature.",
    emailTo: userRows[0].email,
    metadata: { plan: "full_custom", monthlyCreditUsd: input.monthlyCreditUsd },
  })

  return {
    plan: "full_custom",
    status: "active",
    monthlyCreditUsd: input.monthlyCreditUsd,
    allowedModels: input.allowedModels,
    cashCollectedUsd: input.cashCollectedUsd,
    safeCreditsUsd,
    exceededSafeCredits,
    grantCustomActions: false,
    currentPeriodEnd: periodEnd.toISOString(),
    activatedAt: activatedAt.toISOString(),
  }
}

export interface TenantEntitlementOverride {
  customDailyCapUsd: number | null
  customWeeklyCapUsd: number | null
  customMonthlyCapUsd: number | null
  customLimitAction: LimitAction | null
  customAllowedModels: ModelKey[] | null
}

// What makes a Full Custom contract configuration rather than a separate
// code path (tokenallocation.md §7/§21) — billing.service.ts's
// getEntitlementForChatbot/getEntitlementForUser prefer these columns over
// the plan default whenever they're set. Recorded as an ADMIN_OVERRIDE
// routing event so it shows up in the same Routing Activity view as every
// other model-affecting decision, not just in admin_audit_log.
export async function updateTenantEntitlementOverride(
  accessToken: string,
  targetUserId: string,
  override: UpdateTenantOverrideInput,
): Promise<TenantEntitlementOverride> {
  const adminUserId = requireAdminUserId(accessToken)
  const db = requireDbPool()

  if (override.customMonthlyCapUsd != null) {
    if (override.cashCollectedUsd == null || !Number.isFinite(override.cashCollectedUsd) || override.cashCollectedUsd <= 0) {
      throw new AppError(400, "cashCollectedUsd is required when setting a monthly credit grant.")
    }
    try {
      assertGrantLessThanCash(override.customMonthlyCapUsd, override.cashCollectedUsd)
    } catch (err) {
      if (err instanceof CreditGrantInvariantError) throw new AppError(400, err.message)
      throw err
    }
  }

  const { rows } = await db.query<{
    custom_daily_cap_usd: string | null
    custom_weekly_cap_usd: string | null
    custom_monthly_cap_usd: string | null
    custom_limit_action: string | null
    custom_allowed_models: ModelKey[] | null
  }>(
    `update subscriptions set
       custom_daily_cap_usd = coalesce($2, custom_daily_cap_usd),
       custom_weekly_cap_usd = coalesce($3, custom_weekly_cap_usd),
       custom_monthly_cap_usd = coalesce($4, custom_monthly_cap_usd),
       custom_limit_action = coalesce($5, custom_limit_action),
       custom_allowed_models = coalesce($6, custom_allowed_models),
       updated_at = now()
     where user_id = $1
     returning custom_daily_cap_usd, custom_weekly_cap_usd, custom_monthly_cap_usd, custom_limit_action, custom_allowed_models`,
    [
      targetUserId,
      override.customDailyCapUsd ?? null,
      override.customWeeklyCapUsd ?? null,
      override.customMonthlyCapUsd ?? null,
      override.customLimitAction ?? null,
      override.customAllowedModels ? JSON.stringify(override.customAllowedModels) : null,
    ],
  )
  const row = rows[0]
  if (!row) throw new AppError(404, "No subscription found for this user.")

  await db.query(
    "insert into admin_audit_log (admin_user_id, action, target_user_id, detail) values ($1, 'entitlement_override', $2, $3)",
    [adminUserId, targetUserId, JSON.stringify(override)],
  )

  const { rows: chatbotRows } = await db.query<{ id: string }>("select id from chatbots where user_id = $1", [targetUserId])
  await Promise.all(
    chatbotRows.map((c) =>
      recordRoutingEvent({
        requestId: `admin-override-${Date.now()}`,
        chatbotId: c.id,
        selectedModel: override.customAllowedModels?.[0] ?? "n/a",
        reason: "ADMIN_OVERRIDE",
      }),
    ),
  )

  return {
    customDailyCapUsd: row.custom_daily_cap_usd !== null ? Number(row.custom_daily_cap_usd) : null,
    customWeeklyCapUsd: row.custom_weekly_cap_usd !== null ? Number(row.custom_weekly_cap_usd) : null,
    customMonthlyCapUsd: row.custom_monthly_cap_usd !== null ? Number(row.custom_monthly_cap_usd) : null,
    customLimitAction: (row.custom_limit_action as LimitAction | null) ?? null,
    customAllowedModels: row.custom_allowed_models ?? null,
  }
}
