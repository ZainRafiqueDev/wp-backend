import { pool } from "../lib/db.js"
import { listProviderCircuits } from "../lib/circuitBreaker.js"
import { ingestQueueDepth } from "../lib/ingestQueue.js"
import { runWithSystemContext } from "../lib/tenantContext.js"
import { AppError } from "../lib/errors.js"

function requireDb() {
  if (!pool) throw new AppError(503, "Database is not configured.")
  return pool
}

export async function getPlatformHealth() {
  const circuits = await listProviderCircuits(["openai", "anthropic", "gemini"])
  const queueDepth = await ingestQueueDepth().catch(() => 0)
  const db = requireDb()
  const stats = await runWithSystemContext(async () => {
    const failedJobs = await db.query<{ n: string }>(
      `select count(*)::text as n from chatbot_documents where status = 'failed'`,
    )
    const reserved = await db.query<{ n: string; usd: string }>(
      `select count(*)::text as n,
              coalesce(sum(reserved_micro_usd), 0)::text as usd
         from reservations
        where status = 'held'`,
    )
    return { failed: Number(failedJobs.rows[0]?.n ?? 0), reservations: reserved.rows[0] }
  })
  return {
    providers: circuits,
    queue: { queued: queueDepth, failed: stats.failed },
    reservations: {
      active: Number(stats.reservations?.n ?? 0),
      totalReservedUsd: Number(stats.reservations?.usd ?? 0) / 1_000_000,
    },
  }
}

export async function getAiQualityMetrics(days = 7, chatbotId?: string) {
  const db = requireDb()
  return runWithSystemContext(async () => {
    const { rows } = await db.query(
      `select
          coalesce(avg(grounded_answer_rate), 0)::float as grounded,
          coalesce(avg(hallucination_rate), 0)::float as hallucination,
          coalesce(avg(p95_ms), 0)::float as p95,
          coalesce(avg(p50_ms), 0)::float as p50,
          coalesce(sum(pair_count), 0)::int as pairs
         from rag_evaluations
        where pair_count > 0
          and created_at > now() - ($1::text || ' days')::interval
          ${chatbotId ? "and chatbot_id = $2" : ""}`,
      chatbotId ? [String(days), chatbotId] : [String(days)],
    )
    const row = rows[0] ?? {}
    return {
      days,
      chatbotId: chatbotId ?? null,
      groundedAnswerRate: Number(row.grounded ?? 0),
      hallucinationRate: Number(row.hallucination ?? 0),
      p50Ms: Number(row.p50 ?? 0),
      p95Ms: Number(row.p95 ?? 0),
      pairCount: Number(row.pairs ?? 0),
    }
  })
}

export async function getTenantUsage(month: string, limit = 10) {
  const db = requireDb()
  const period = month || new Date().toISOString().slice(0, 7)
  return runWithSystemContext(async () => {
    const { rows } = await db.query(
      `select c.id as chatbot_id, c.name, u.email as owner_email,
              coalesce(sum(cu.estimated_cost), 0)::float as spent_usd,
              coalesce(sum(cu.input_tokens + cu.output_tokens), 0)::bigint as tokens
         from chatbots c
         join users u on u.id = c.user_id
         left join chatbot_usage cu
           on cu.chatbot_id = c.id and cu.billing_period = $1
        group by c.id, c.name, u.email
        order by spent_usd desc
        limit $2`,
      [period, Math.min(limit, 50)],
    )
    return { month: period, tenants: rows }
  })
}

export async function getProviderStatus() {
  return { providers: await listProviderCircuits(["openai", "anthropic", "gemini"]) }
}

export async function getQueueDepth() {
  const depth = await ingestQueueDepth().catch(() => 0)
  return { depth }
}

export async function getOkfMetrics(days = 7) {
  const db = requireDb()
  return runWithSystemContext(async () => {
    const routing = await db.query<{
      total: string
      okf_hits: string
      fallbacks: string
    }>(
      `select count(*)::text as total,
              count(*) filter (where matched)::text as okf_hits,
              count(*) filter (where routing_method = 'okf_fallback_rag')::text as fallbacks
         from okf_routing_log
        where created_at > now() - ($1::text || ' days')::interval`,
      [String(days)],
    )
    const pending = await db.query<{ n: string }>(
      `select count(*)::text as n from okf_concepts where is_active and approved_at is null`,
    )
    const live = await db.query<{ n: string }>(
      `select count(*)::text as n from okf_concepts where is_active and approved_at is not null`,
    )
    const latency = await db.query<{ approval_hours: string | null }>(
      `select avg(extract(epoch from (approved_at - created_at)) / 3600)::text as approval_hours
         from okf_concepts
        where approved_at is not null and created_by = 'ai_extracted'`,
    )
    const total = Number(routing.rows[0]?.total ?? 0)
    const hits = Number(routing.rows[0]?.okf_hits ?? 0)
    const fallbacks = Number(routing.rows[0]?.fallbacks ?? 0)
    return {
      days,
      routerHitRate: total > 0 ? hits / total : 0,
      coverageGapRate: total > 0 ? fallbacks / total : 0,
      pendingApproval: Number(pending.rows[0]?.n ?? 0),
      activeConceptCount: Number(live.rows[0]?.n ?? 0),
      approvalLatencyHours: latency.rows[0]?.approval_hours == null ? null : Number(latency.rows[0].approval_hours),
      okfAnswerRate: 1,
      ragAnswerRate: null as number | null,
    }
  })
}
