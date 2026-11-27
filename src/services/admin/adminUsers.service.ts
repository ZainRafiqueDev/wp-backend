import { hasStripe } from "../../env.js"
import { revokeAllUserSessions } from "../../lib/auth.js"
import { AppError } from "../../lib/errors.js"
import type { ModelKey } from "../../lib/plans.js"
import { isEntitledStatus } from "../billing.service.js"
import { currentBillingPeriod } from "../usage.service.js"
import { requireAdminUserId } from "./adminAuth.service.js"
import { cancelStripeSubscriptionOrThrow } from "./adminPlans.service.js"
import { logAdminAction, requireDbPool } from "./shared.js"

export interface AdminUserListItem {
  id: string
  email: string
  name: string
  isActive: boolean
  trialStartedAt: string
  plan: string
  planActive: boolean

  chatbotCount: number
  inactiveChatbotCount: number
  /** SA-01: workspace members of this account (excludes the owner). */
  memberCount: number
  currentPeriodInputTokens: number
  currentPeriodOutputTokens: number
  currentPeriodEstimatedCostUsd: number
}

export const ADMIN_USER_LIST_DEFAULT_LIMIT = 50
export const ADMIN_USER_LIST_MAX_LIMIT = 100

export interface AdminUserListPage {
  users: AdminUserListItem[]
  totalCount: number
}

// Was hard-capped at 200 rows with no way to see further accounts at all —
// fine while the platform had a handful of customers, silently wrong once it
// didn't. limit/offset (not cursor-based) matches how this admin table is
// actually used today: jump-to-page from the UI's page-number controls, not
// an infinite-scroll feed.
export async function listUsers(
  accessToken: string,
  search?: string,
  limit = ADMIN_USER_LIST_DEFAULT_LIMIT,
  offset = 0,
): Promise<AdminUserListPage> {
  requireAdminUserId(accessToken)
  const db = requireDbPool()
  const period = currentBillingPeriod()

  const safeLimit = Math.min(ADMIN_USER_LIST_MAX_LIMIT, Math.max(1, Math.floor(limit) || ADMIN_USER_LIST_DEFAULT_LIMIT))
  const safeOffset = Math.max(0, Math.floor(offset) || 0)

  const params: unknown[] = [period]
  let where = ""
  if (search?.trim()) {
    params.push(`%${search.trim().toLowerCase()}%`)
    where = "where lower(u.email) like $2 or lower(u.name) like $2"
  }

  const countParams = where ? [params[1]] : []
  const countQuery = where
    ? `select count(*)::int as total from users u ${where.replaceAll("$2", "$1")}`
    : "select count(*)::int as total from users u"
  const countResult = await db.query<{ total: number }>(countQuery, countParams)
  const totalCount = countResult.rows[0]?.total ?? 0

  const limitParamIndex = params.length + 1
  const offsetParamIndex = params.length + 2
  params.push(safeLimit, safeOffset)

  const { rows } = await db.query<{
    id: string
    email: string
    name: string
    is_active: boolean
    trial_started_at: Date
    plan: string | null
    status: string | null
    chatbot_count: string | null
    inactive_chatbot_count: string | null
    member_count: number | null
    input_tokens: string | null
    output_tokens: string | null
    estimated_cost: string | null
  }>(
    `select u.id, u.email, u.name, u.is_active, u.trial_started_at,
            s.plan, s.status,
            cb.chatbot_count, cb.inactive_chatbot_count,
            (select count(*)::int from workspace_members wm where wm.owner_user_id = u.id) as member_count,
            us.input_tokens, us.output_tokens, us.estimated_cost
     from users u
     left join subscriptions s on s.user_id = u.id
     left join (
       select user_id,
              count(*) as chatbot_count,
              count(*) filter (where not is_active) as inactive_chatbot_count
       from chatbots
       group by user_id
     ) cb on cb.user_id = u.id
     left join (
       select c.user_id,
              sum(cu.input_tokens) as input_tokens,
              sum(cu.output_tokens) as output_tokens,
              sum(cu.estimated_cost) as estimated_cost
       from chatbots c
       join chatbot_usage cu on cu.chatbot_id = c.id and cu.billing_period = $1
       group by c.user_id
     ) us on us.user_id = u.id
     ${where}
     order by u.trial_started_at desc, u.id desc
     limit $${limitParamIndex} offset $${offsetParamIndex}`,
    params,
  )

  return {
    users: rows.map((row) => ({
      id: row.id,
      email: row.email,
      name: row.name,
      isActive: row.is_active,
      trialStartedAt: row.trial_started_at.toISOString(),
      plan: row.plan || "free",
      planActive: Boolean(row.status && isEntitledStatus(row.status)),
      chatbotCount: Number(row.chatbot_count || 0),
      inactiveChatbotCount: Number(row.inactive_chatbot_count || 0),
      memberCount: Number(row.member_count || 0),
      currentPeriodInputTokens: Number(row.input_tokens || 0),
      currentPeriodOutputTokens: Number(row.output_tokens || 0),
      currentPeriodEstimatedCostUsd: Number(row.estimated_cost || 0),
    })),
    totalCount,
  }
}

export interface AdminUserDetail extends AdminUserListItem {
  currentPeriodEnd: string | null
  monthlyCreditUsd: number | null
  allowedModels: ModelKey[] | null
  activatedAt: string | null
  activatedByAdminId: string | null
  chatbots: { id: string; name: string; isActive: boolean; status: string; createdAt: string }[]
}

// The list endpoint's row shape, but for exactly one account, plus the
// chatbot roster — enough for a real detail page (deep account view) without
// a second round trip. Re-runs the same per-period aggregation as listUsers
// rather than trying to derive this row from a client-cached list entry,
// since a detail page has to work from a direct link/refresh with nothing
// cached.
export async function getUserDetail(accessToken: string, targetUserId: string): Promise<AdminUserDetail> {
  requireAdminUserId(accessToken)
  const db = requireDbPool()
  const period = currentBillingPeriod()

  const { rows } = await db.query<{
    id: string
    email: string
    name: string
    is_active: boolean
    trial_started_at: Date
    plan: string | null
    status: string | null
    current_period_end: Date | null
    custom_monthly_cap_usd: string | null
    custom_allowed_models: ModelKey[] | null
    activated_at: Date | null
    activated_by: string | null
    chatbot_count: string | null
    inactive_chatbot_count: string | null
    member_count: number | null
    input_tokens: string | null
    output_tokens: string | null
    estimated_cost: string | null
  }>(
    `select u.id, u.email, u.name, u.is_active, u.trial_started_at,
            s.plan, s.status, s.current_period_end,
            s.custom_monthly_cap_usd, s.custom_allowed_models, s.activated_at, s.activated_by,
            cb.chatbot_count, cb.inactive_chatbot_count,
            (select count(*)::int from workspace_members wm where wm.owner_user_id = u.id) as member_count,
            us.input_tokens, us.output_tokens, us.estimated_cost
     from users u
     left join subscriptions s on s.user_id = u.id
     left join (
       select user_id,
              count(*) as chatbot_count,
              count(*) filter (where not is_active) as inactive_chatbot_count
       from chatbots
       group by user_id
     ) cb on cb.user_id = u.id
     left join (
       select c.user_id,
              sum(cu.input_tokens) as input_tokens,
              sum(cu.output_tokens) as output_tokens,
              sum(cu.estimated_cost) as estimated_cost
       from chatbots c
       join chatbot_usage cu on cu.chatbot_id = c.id and cu.billing_period = $2
       group by c.user_id
     ) us on us.user_id = u.id
     where u.id = $1`,
    [targetUserId, period],
  )
  const row = rows[0]
  if (!row) throw new AppError(404, "User not found.")

  const { rows: chatbotRows } = await db.query<{
    id: string
    name: string
    is_active: boolean
    status: string
    created_at: Date
  }>("select id, name, is_active, status, created_at from chatbots where user_id = $1 order by created_at desc", [targetUserId])

  return {
    id: row.id,
    email: row.email,
    name: row.name,
    isActive: row.is_active,
    trialStartedAt: row.trial_started_at.toISOString(),
    plan: row.plan || "free",
    planActive: Boolean(row.status && isEntitledStatus(row.status)),
    currentPeriodEnd: row.current_period_end ? row.current_period_end.toISOString() : null,
    monthlyCreditUsd: row.custom_monthly_cap_usd !== null ? Number(row.custom_monthly_cap_usd) : null,
    allowedModels: row.custom_allowed_models ?? null,
    activatedAt: row.activated_at ? row.activated_at.toISOString() : null,
    activatedByAdminId: row.activated_by,
    chatbotCount: Number(row.chatbot_count || 0),
    inactiveChatbotCount: Number(row.inactive_chatbot_count || 0),
    memberCount: Number(row.member_count || 0),
    currentPeriodInputTokens: Number(row.input_tokens || 0),
    currentPeriodOutputTokens: Number(row.output_tokens || 0),
    currentPeriodEstimatedCostUsd: Number(row.estimated_cost || 0),
    chatbots: chatbotRows.map((c) => ({
      id: c.id,
      name: c.name,
      isActive: c.is_active,
      status: c.status,
      createdAt: c.created_at.toISOString(),
    })),
  }
}

export async function setUserActive(accessToken: string, targetUserId: string, isActive: boolean): Promise<void> {
  const adminUserId = requireAdminUserId(accessToken)
  const db = requireDbPool()

  const { rowCount } = await db.query("update users set is_active = $1 where id = $2", [isActive, targetUserId])
  if (!rowCount) throw new AppError(404, "User not found.")
  // CS-11: requireAuth already refuses inactive users on every request. Also
  // retire their access and refresh tokens so reactivating the account later
  // does not bring the old sessions back.
  if (!isActive) await revokeAllUserSessions(db, targetUserId)

  await logAdminAction(adminUserId, isActive ? "activate_user" : "deactivate_user", targetUserId)
}

export async function deleteUser(accessToken: string, targetUserId: string, confirmed: boolean): Promise<void> {
  const adminUserId = requireAdminUserId(accessToken)
  if (!confirmed) {
    throw new AppError(400, "Pass { confirm: true } to permanently delete this user and all their data.")
  }

  const db = requireDbPool()
  const { rows } = await db.query<{ email: string }>("select email from users where id = $1", [targetUserId])
  if (!rows[0]) throw new AppError(404, "User not found.")

  // CS-13 (B06-006): stop Stripe billing before the account (and with it
  // the subscriptions row that links to Stripe) is gone. A failed cancel
  // aborts the delete.
  const { rows: subs } = await db.query<{ stripe_subscription_id: string | null }>(
    "select stripe_subscription_id from subscriptions where user_id = $1",
    [targetUserId],
  )
  const sub = subs[0]
  if (sub?.stripe_subscription_id && hasStripe) {
    await cancelStripeSubscriptionOrThrow(sub.stripe_subscription_id, { targetUserId, action: "delete_user" })
  }

  await logAdminAction(adminUserId, "delete_user", targetUserId, { email: rows[0].email })
  await db.query("delete from users where id = $1", [targetUserId])
}
