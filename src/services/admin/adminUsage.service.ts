import { currentBillingPeriod, getPlatformBudgetStatus, type PlatformBudgetStatus } from "../usage.service.js"
import { requireAdminUserId } from "./adminAuth.service.js"
import { requireDbPool } from "./shared.js"

export interface AdminUsageBreakdownEntry {
  chatbotId: string
  chatbotName: string
  billingPeriod: string
  model: string
  inputTokens: number
  outputTokens: number
  estimatedCostUsd: number
}

// `model` is now selected (it wasn't before — a real gap: chatbot_usage has
// carried a model column for a while, but this query never read it, so the
// admin usage-history list could never show a per-model breakdown, only a
// per-chatbot-per-period total across whichever models were mixed into it).
export async function getUserUsageBreakdown(accessToken: string, targetUserId: string): Promise<AdminUsageBreakdownEntry[]> {
  requireAdminUserId(accessToken)
  const db = requireDbPool()

  const { rows } = await db.query<{
    chatbot_id: string
    chatbot_name: string
    billing_period: string
    model: string | null
    input_tokens: string
    output_tokens: string
    estimated_cost: string
  }>(
    `select cu.chatbot_id, c.name as chatbot_name, cu.billing_period, cu.model, cu.input_tokens, cu.output_tokens, cu.estimated_cost
     from chatbot_usage cu
     join chatbots c on c.id = cu.chatbot_id
     where c.user_id = $1
     order by cu.billing_period desc`,
    [targetUserId],
  )

  return rows.map((row) => ({
    chatbotId: row.chatbot_id,
    chatbotName: row.chatbot_name,
    billingPeriod: row.billing_period,
    model: row.model ?? "unknown",
    inputTokens: Number(row.input_tokens),
    outputTokens: Number(row.output_tokens),
    estimatedCostUsd: Number(row.estimated_cost),
  }))
}

export interface AdminPlatformUsageSummary {
  billingPeriod: string
  totalUsers: number
  activeUsers: number
  activeSubscriptions: number
  planCounts: { free: number; crawlPlus: number; fullCustom: number }
  totalInputTokens: number
  totalOutputTokens: number
  totalEstimatedCostUsd: number
  byModel: { model: string; inputTokens: number; outputTokens: number; estimatedCostUsd: number }[]
  topSpenders: {
    userId: string
    email: string
    name: string
    inputTokens: number
    outputTokens: number
    estimatedCostUsd: number
  }[]
}

// Platform-wide totals for this billing period — deliberately separate from
// listUsers (which is per-account) so this can be one cheap dashboard call
// instead of the admin frontend summing 200 rows itself.
export async function getPlatformUsageSummary(accessToken: string): Promise<AdminPlatformUsageSummary> {
  requireAdminUserId(accessToken)
  const db = requireDbPool()
  const period = currentBillingPeriod()

  const [countsResult, modelResult, spendersResult] = await Promise.all([
    db.query<{
      total_users: string
      active_users: string
      active_subscriptions: string
      crawl_plus_count: string
      full_custom_count: string
    }>(
      `select
         count(*) as total_users,
         count(*) filter (where u.is_active) as active_users,
         count(*) filter (where s.status in ('active', 'trialing')) as active_subscriptions,
         count(*) filter (where s.plan = 'crawl_plus' and s.status in ('active', 'trialing')) as crawl_plus_count,
         count(*) filter (where s.plan = 'full_custom' and s.status in ('active', 'trialing')) as full_custom_count
       from users u
       left join subscriptions s on s.user_id = u.id`,
    ),
    db.query<{ model: string | null; input_tokens: string; output_tokens: string; estimated_cost: string }>(
      `select coalesce(model, 'unknown') as model, sum(input_tokens) as input_tokens, sum(output_tokens) as output_tokens, sum(estimated_cost) as estimated_cost
       from chatbot_usage
       where billing_period = $1
       group by coalesce(model, 'unknown')
       order by sum(estimated_cost) desc`,
      [period],
    ),
    db.query<{
      user_id: string
      email: string
      name: string
      input_tokens: string
      output_tokens: string
      estimated_cost: string
    }>(
      `select u.id as user_id, u.email, u.name, us.input_tokens, us.output_tokens, us.estimated_cost
       from users u
       join (
         select c.user_id,
                sum(cu.input_tokens) as input_tokens,
                sum(cu.output_tokens) as output_tokens,
                sum(cu.estimated_cost) as estimated_cost
         from chatbots c
         join chatbot_usage cu on cu.chatbot_id = c.id and cu.billing_period = $1
         group by c.user_id
       ) us on us.user_id = u.id
       order by us.estimated_cost desc
       limit 5`,
      [period],
    ),
  ])

  const counts = countsResult.rows[0]
  const totalUsers = Number(counts?.total_users || 0)
  const crawlPlus = Number(counts?.crawl_plus_count || 0)
  const fullCustom = Number(counts?.full_custom_count || 0)

  const byModel = modelResult.rows.map((row) => ({
    model: row.model || "unknown",
    inputTokens: Number(row.input_tokens || 0),
    outputTokens: Number(row.output_tokens || 0),
    estimatedCostUsd: Number(row.estimated_cost || 0),
  }))

  return {
    billingPeriod: period,
    totalUsers,
    activeUsers: Number(counts?.active_users || 0),
    activeSubscriptions: Number(counts?.active_subscriptions || 0),
    planCounts: { free: Math.max(0, totalUsers - crawlPlus - fullCustom), crawlPlus, fullCustom },
    totalInputTokens: byModel.reduce((sum, m) => sum + m.inputTokens, 0),
    totalOutputTokens: byModel.reduce((sum, m) => sum + m.outputTokens, 0),
    totalEstimatedCostUsd: byModel.reduce((sum, m) => sum + m.estimatedCostUsd, 0),
    byModel,
    topSpenders: spendersResult.rows.map((row) => ({
      userId: row.user_id,
      email: row.email,
      name: row.name,
      inputTokens: Number(row.input_tokens || 0),
      outputTokens: Number(row.output_tokens || 0),
      estimatedCostUsd: Number(row.estimated_cost || 0),
    })),
  }
}

// --- Token/cost allocation admin oversight (tokenallocation.md §9) ------

export async function getAdminPlatformBudgetStatus(accessToken: string): Promise<PlatformBudgetStatus[]> {
  requireAdminUserId(accessToken)
  return getPlatformBudgetStatus()
}
