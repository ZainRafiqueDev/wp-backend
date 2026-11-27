import { env } from "../../env.js"
import { requireAdminUserId } from "./adminAuth.service.js"
import { requireDbPool } from "./shared.js"

export interface AdminNotification {
  id: string
  action: string
  adminName: string | null
  adminEmail: string | null
  targetUserId: string | null
  targetUserEmail: string | null
  detail: Record<string, unknown>
  createdAt: string
}

// An admin "notifications" feed built entirely from real, already-tracked
// state rather than a fabricated inbox — six genuine sources merged and
// sorted by time:
//   1. admin_audit_log   — every admin-triggered action (who did what)
//   2. open abuse flags  — chatbots flagged and not yet reviewed
//   3. past-due subscriptions — a real failed-payment signal (Stripe
//      webhook sets this; see billing.service.ts's invoice.payment_failed)
//   4. accounts the SYSTEM auto-deactivated on trial expiry (distinct from
//      an admin's own deactivate_user action, which already appears via #1)
//   5. new signups in the last 14 days
//   6. new Full Custom leads in the last 14 days (lead.service.ts) — this
//      is also emailed in real time (notifyAdminOfNewLead); this entry is
//      what makes the same event visible in-app too, not a replacement.
// Each source reuses the same {action, ...} shape so the frontend can treat
// them uniformly; "action" doubles as a stable key for icon/label lookup.
export async function listAdminNotifications(accessToken: string, limit = 60): Promise<AdminNotification[]> {
  requireAdminUserId(accessToken)
  const db = requireDbPool()

  const [auditResult, abuseResult, pastDueResult, trialExpiredResult, signupResult, leadResult] = await Promise.all([
    db.query<{
      id: string
      action: string
      admin_name: string | null
      admin_email: string | null
      target_user_id: string | null
      target_user_email: string | null
      detail: Record<string, unknown>
      created_at: Date
    }>(
      `select l.id, l.action, a.name as admin_name, a.email as admin_email,
              l.target_user_id, u.email as target_user_email, l.detail, l.created_at
       from admin_audit_log l
       left join admin_users a on a.id = l.admin_user_id
       left join users u on u.id = l.target_user_id
       order by l.created_at desc
       limit $1`,
      [limit],
    ),
    db.query<{ id: string; chatbot_name: string; user_id: string; user_email: string; reason: string; created_at: Date }>(
      `select f.id, c.name as chatbot_name, c.user_id, u.email as user_email, f.reason, f.created_at
       from chatbot_abuse_flags f
       join chatbots c on c.id = f.chatbot_id
       join users u on u.id = c.user_id
       where f.reviewed = false
       order by f.created_at desc
       limit $1`,
      [limit],
    ),
    db.query<{ user_id: string; email: string; plan: string; updated_at: Date }>(
      `select s.user_id, u.email, s.plan, s.updated_at
       from subscriptions s
       join users u on u.id = s.user_id
       where s.status = 'past_due'
       order by s.updated_at desc
       limit $1`,
      [limit],
    ),
    db.query<{ id: string; email: string; trial_started_at: Date }>(
      `select id, email, trial_started_at from users where trial_deactivated = true order by trial_started_at desc limit $1`,
      [limit],
    ),
    db.query<{ id: string; email: string; trial_started_at: Date }>(
      `select id, email, trial_started_at from users where trial_started_at > now() - interval '14 days' order by trial_started_at desc limit $1`,
      [limit],
    ),
    db.query<{ id: string; name: string; email: string; selected_bots: string[]; created_at: Date }>(
      `select id, name, email, selected_bots, created_at from leads
       where status = 'lead' and created_at > now() - interval '14 days'
       order by created_at desc limit $1`,
      [limit],
    ),
  ])

  const trialMs = env.trialLengthDays * 24 * 60 * 60 * 1000

  const audit: AdminNotification[] = auditResult.rows.map((row) => ({
    id: `audit:${row.id}`,
    action: row.action,
    adminName: row.admin_name,
    adminEmail: row.admin_email,
    targetUserId: row.target_user_id,
    targetUserEmail: row.target_user_email,
    detail: row.detail || {},
    createdAt: row.created_at.toISOString(),
  }))

  const abuse: AdminNotification[] = abuseResult.rows.map((row) => ({
    id: `abuse:${row.id}`,
    action: "abuse_flag_open",
    adminName: null,
    adminEmail: null,
    targetUserId: row.user_id,
    targetUserEmail: row.user_email,
    detail: { flagId: row.id, chatbotName: row.chatbot_name, reason: row.reason },
    createdAt: row.created_at.toISOString(),
  }))

  const pastDue: AdminNotification[] = pastDueResult.rows.map((row) => ({
    id: `pastdue:${row.user_id}`,
    action: "payment_past_due",
    adminName: null,
    adminEmail: null,
    targetUserId: row.user_id,
    targetUserEmail: row.email,
    detail: { plan: row.plan },
    createdAt: row.updated_at.toISOString(),
  }))

  const trialExpired: AdminNotification[] = trialExpiredResult.rows.map((row) => ({
    id: `trialexp:${row.id}`,
    action: "trial_auto_deactivated",
    adminName: null,
    adminEmail: null,
    targetUserId: row.id,
    targetUserEmail: row.email,
    detail: {},
    createdAt: new Date(row.trial_started_at.getTime() + trialMs).toISOString(),
  }))

  const signups: AdminNotification[] = signupResult.rows.map((row) => ({
    id: `signup:${row.id}`,
    action: "new_signup",
    adminName: null,
    adminEmail: null,
    targetUserId: row.id,
    targetUserEmail: row.email,
    detail: {},
    createdAt: row.trial_started_at.toISOString(),
  }))

  const leads: AdminNotification[] = leadResult.rows.map((row) => ({
    id: `lead:${row.id}`,
    action: "new_lead",
    adminName: null,
    adminEmail: null,
    targetUserId: null,
    targetUserEmail: row.email,
    detail: { name: row.name, selectedBots: row.selected_bots || [] },
    createdAt: row.created_at.toISOString(),
  }))

  return [...audit, ...abuse, ...pastDue, ...trialExpired, ...signups, ...leads]
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, limit)
}
