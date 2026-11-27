import { env } from "../env.js"
import { pool } from "../lib/db.js"
import { log } from "../lib/logger.js"
import { runWithSystemContext } from "../lib/tenantContext.js"
import { incrementUsageMetric } from "../lib/usageMetrics.js"
import { getEntitlementForChatbot, isEntitledStatus, isHeldPaidPlan } from "./billing.service.js"
import { getCostCapBlock } from "./usage.service.js"
import { tryAutoPurchaseTopup } from "./autoPurchase.service.js"
import { createNotification } from "./notification.service.js"


export type GateReason =
  | "chatbot_deactivated"
  | "account_deactivated"
  | "trial_expired"
  | "monthly_credits_exhausted"
  /**
   * @deprecated Master prompt decision (2026-09-28) — day/week pace limits
   * no longer block customers at all (only monthly exhaustion does; see
   * usage.service.ts's getCostCapBlock, which now only ever returns
   * `{ kind: "monthly" }` or null). Kept so older widgets, mocks, and
   * recrawl checks still type-check. Treat incoming/legacy values as
   * monthly credit exhaustion.
   */
  | "burst_limited"
  /**
   * @deprecated WP-1.2 — the API no longer emits this reason.
   * Kept so older widgets, mocks, and recrawl checks still type-check.
   * Treat incoming/legacy values as monthly credit exhaustion.
   * See docs/USAGE_GATE_REASONS.md.
   */
  | "cost_cap_exceeded"
  /**
   * CS-13 (B06-008): the gate itself could not be evaluated (database,
   * Redis or Stripe lookup failed). The request is refused rather than
   * answered unchecked; callers show their generic fallback message.
   */
  | "gate_unavailable"

export const MONTHLY_CREDITS_VISITOR_MESSAGE =
  "This chatbot has used its monthly AI credits. The owner can top up or upgrade from Billing."

export function isUsageGateReason(reason: GateReason | undefined): boolean {
  return reason === "monthly_credits_exhausted" || reason === "burst_limited" || reason === "cost_cap_exceeded"
}

export function visitorMessageForGate(reason: GateReason | undefined, fallback: string): string {
  if (reason === "monthly_credits_exhausted" || reason === "cost_cap_exceeded" || reason === "burst_limited") {
    return MONTHLY_CREDITS_VISITOR_MESSAGE
  }
  return fallback
}

export interface GateResult {
  blocked: boolean
  reason?: GateReason
  visitorMessage?: string
  retryAfterSeconds?: number
}

const NOT_BLOCKED: GateResult = { blocked: false }

/** Seconds a client should wait before retrying after a gate_unavailable block. */
export const GATE_UNAVAILABLE_RETRY_AFTER_SECONDS = 30

// Persists trial expiry onto users.trial_deactivated the first time it's
// detected, instead of only ever re-deriving "is this trial expired" from
// trial_started_at math on every single request. Idempotent (a second call
// after it's already true is a no-op update) — safe to call from every
// gate check that finds an expired, unpaid trial.
async function persistTrialDeactivation(userId: string): Promise<void> {
  if (!pool) return
  console.log(`[accessGate.service] persistTrialDeactivation: userId=${userId}`)
  try {
    await pool.query("update users set trial_deactivated = true where id = $1 and trial_deactivated = false", [userId])
  } catch (err) {
    console.error(`[accessGate.service] persistTrialDeactivation: FAILED userId=${userId}`, err)
    log().warn({ userId, err: err instanceof Error ? err.message : String(err) }, "failed to persist trial deactivation")
  }
}

export async function checkAnsweringGate(chatbotId: string): Promise<GateResult> {
  if (!pool) return NOT_BLOCKED

  // This is a system-level authorization check (trial/deactivation/billing
  // status), not tenant data access, so it must not be gated by the
  // *caller's* RLS scope. A public widget visitor's request runs under
  // scope "public" (chatbotId only, no userId) — the users_isolation RLS
  // policy only grants a row to its own owner (app.user_id match) or an
  // "auth"-scope email/google_id match, so without this, the `join users`
  // below silently returns zero rows for any public-chat request and this
  // whole gate falls through to NOT_BLOCKED unconditionally, regardless of
  // trial expiry, deactivation, or monthly credit exhaustion. Confirmed via
  // a real integration test hitting the public endpoint directly — this
  // predates today's session-memory work and affects everywhere this
  // function is called (public.service.ts, commerceEntrypoint.ts,
  // booklyEntrypoint.ts), not something new.
  return runWithSystemContext(() => checkAnsweringGateInner(chatbotId))
}

async function checkAnsweringGateInner(chatbotId: string): Promise<GateResult> {
  try {
    const { rows } = await pool!.query<{
      user_id: string
      chatbot_is_active: boolean
      user_is_active: boolean
      trial_started_at: Date
      trial_deactivated: boolean
    }>(
      `select c.user_id, c.is_active as chatbot_is_active, u.is_active as user_is_active,
              u.trial_started_at, u.trial_deactivated
       from chatbots c
       join users u on u.id = c.user_id
       where c.id = $1`,
      [chatbotId],
    )
    const row = rows[0]
    // No chatbot/owner row: nothing is entitled to answer.
    if (!row) return { blocked: true, reason: "chatbot_deactivated" }

    if (!row.chatbot_is_active) return { blocked: true, reason: "chatbot_deactivated" }
    if (!row.user_is_active) return { blocked: true, reason: "account_deactivated" }

    // Fast path: already persisted from a previous request — no date math,
    // no entitlement lookup, just the flag this same query already fetched.
    if (row.trial_deactivated) return { blocked: true, reason: "trial_expired" }

    const entitlement = await getEntitlementForChatbot(chatbotId)
    if (!entitlement.active) {
      const trialEndsAtMs = row.trial_started_at.getTime() + env.trialLengthDays * 24 * 60 * 60 * 1000
      if (Date.now() >= trialEndsAtMs) {
        await persistTrialDeactivation(row.user_id)
        return { blocked: true, reason: "trial_expired" }
      }
    }

    const costBlock = await getCostCapBlock(chatbotId)
    if (costBlock) {
      const purchased = await tryAutoPurchaseTopup(chatbotId)
      if (purchased && !(await getCostCapBlock(chatbotId))) {
        return NOT_BLOCKED
      }
      void incrementUsageMetric("usage.monthly_blocked", { chatbotId })
      if (pool) {
        const { rows: owner } = await pool.query<{ user_id: string; email: string }>(
          `select u.id as user_id, u.email from chatbots c join users u on u.id = c.user_id where c.id = $1`,
          [chatbotId],
        )
        if (owner[0]) {
          const { rows: recent } = await pool.query<{ id: string }>(
            `select id from notifications
             where user_id = $1 and type = 'usage_limit'
               and created_at > date_trunc('day', now() at time zone 'utc')
             limit 1`,
            [owner[0].user_id],
          )
          if (!recent[0]) {
            void createNotification({
              userId: owner[0].user_id,
              type: "usage_limit",
              title: "Monthly AI credits used",
              body: "This chatbot has used its monthly AI credits. Buy a top-up or upgrade from Billing.",
              emailTo: owner[0].email,
              metadata: { chatbotId },
            })
          }
        }
      }
      return {
        blocked: true,
        reason: "monthly_credits_exhausted",
        visitorMessage: MONTHLY_CREDITS_VISITOR_MESSAGE,
      }
    }

    return NOT_BLOCKED
  } catch (err) {
    // CS-13 (B06-008): fail closed. Answering while deactivation, trial and
    // credit checks cannot run would let deactivated or credit-exhausted
    // chatbots keep spending on LLM calls whenever a dependency is degraded.
    log().error(
      { chatbotId, event: "answering_gate_unavailable", err: err instanceof Error ? err.message : String(err) },
      "answering gate check failed, refusing request",
    )
    return { blocked: true, reason: "gate_unavailable", retryAfterSeconds: GATE_UNAVAILABLE_RETRY_AFTER_SECONDS }
  }
}

export interface AccountStatus {
  trialStartedAt: string
  trialEndsAt: string
  isTrialExpired: boolean
  // Admin (whole-account) deactivation — users.is_active.
  isActive: boolean
  // Abuse-detection (single-chatbot) deactivation — chatbots.is_active.
  // Null when the account has no chatbot yet.
  chatbotIsActive: boolean | null
  plan: string
  planActive: boolean
  onHold: boolean
  currentPeriodEnd: string | null
}

export async function getAccountStatus(userId: string, chatbotId: string | null): Promise<AccountStatus> {
  if (!pool) {
    const now = new Date().toISOString()
    return {
      trialStartedAt: now,
      trialEndsAt: now,
      isTrialExpired: false,
      isActive: true,
      chatbotIsActive: null,
      plan: "free",
      planActive: false,
      onHold: false,
      currentPeriodEnd: null,
    }
  }

  const { rows } = await pool.query<{ trial_started_at: Date; is_active: boolean; trial_deactivated: boolean }>(
    "select trial_started_at, is_active, trial_deactivated from users where id = $1",
    [userId],
  )
  const row = rows[0]
  const trialStartedAt = row?.trial_started_at ?? new Date()
  const trialEndsAtMs = trialStartedAt.getTime() + env.trialLengthDays * 24 * 60 * 60 * 1000

  const { rows: subRows } = await pool.query<{
    plan: string
    status: string
    current_period_end: Date | null
  }>("select plan, status, current_period_end from subscriptions where user_id = $1", [userId])
  const sub = subRows[0]
  const subscribedPlan = sub?.plan || "free"
  const planActive = Boolean(sub && isEntitledStatus(sub.status))
  const onHold = isHeldPaidPlan(subscribedPlan, sub?.status)

  const entitlement = chatbotId ? await getEntitlementForChatbot(chatbotId) : { active: planActive }

  let chatbotIsActive: boolean | null = null
  if (chatbotId) {
    const { rows: chatbotRows } = await pool.query<{ is_active: boolean }>(
      "select is_active from chatbots where id = $1",
      [chatbotId],
    )
    chatbotIsActive = chatbotRows[0]?.is_active ?? null
  }

  return {
    trialStartedAt: trialStartedAt.toISOString(),
    trialEndsAt: new Date(trialEndsAtMs).toISOString(),
    // The persisted flag wins if set (trusts what the gate already wrote),
    // falling back to the live date check for a user who hasn't made an
    // answering request since the trial expired (nothing has persisted it
    // yet, but the dashboard should still show it as expired).
    isTrialExpired: Boolean(row?.trial_deactivated) || (!entitlement.active && Date.now() >= trialEndsAtMs),
    isActive: row?.is_active ?? true,
    chatbotIsActive,
    plan: subscribedPlan,
    planActive,
    onHold,
    currentPeriodEnd: sub?.current_period_end ? sub.current_period_end.toISOString() : null,
  }
}
