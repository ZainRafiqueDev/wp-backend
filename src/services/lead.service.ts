import { env } from "../env.js"
import { verifyAccessToken } from "../lib/auth.js"
import { pool } from "../lib/db.js"
import { sendEmail } from "../lib/email.js"
import { AppError } from "../lib/errors.js"
import { log, shortRef } from "../lib/logger.js"
import { setTenantContext } from "../lib/tenantContext.js"
import { resolveLiveAccessToken } from "../middleware/requireAuth.js"
import type { CreateLeadInput, UpdateLeadInput } from "../validators/lead.validator.js"

function requireDbPool() {
  if (!pool) {
    throw new AppError(503, "Database is not configured. Set DATABASE_URL and JWT_SECRET.")
  }
  return pool
}

function requireUserId(accessToken: string): string {
  const userId = verifyAccessToken(accessToken)
  if (!userId) throw new AppError(401, "Please sign in again.")
  return userId
}

// A public submission may or may not carry a token — resolve it only if a
// real one was actually sent, never throw for the anonymous case (unlike
// requireUserId above, which is for routes that mandate a signed-in caller).
// CS-11: same liveness check as requireAuth (deactivated users, logged-out
// or revoked sessions resolve to anonymous), not just the signature.
async function optionalUserId(accessToken: string): Promise<string | null> {
  if (!accessToken) return null
  return resolveLiveAccessToken(accessToken)
}

export type LeadStatus = "lead" | "booked"

export interface Lead {
  id: string
  userId: string | null
  name: string
  email: string
  phone: string
  selectedBots: string[]
  status: LeadStatus
  calendlyEventUri: string | null
  meetingStartsAt: string | null
  meetingName: string | null
  createdAt: string
  updatedAt: string
}

interface LeadRow {
  id: string
  user_id: string | null
  name: string
  email: string
  phone: string
  selected_bots: string[]
  status: LeadStatus
  calendly_event_uri: string | null
  meeting_starts_at: Date | null
  meeting_name: string | null
  created_at: Date
  updated_at: Date
}

function rowToLead(row: LeadRow): Lead {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    selectedBots: row.selected_bots || [],
    status: row.status,
    calendlyEventUri: row.calendly_event_uri,
    meetingStartsAt: row.meeting_starts_at ? row.meeting_starts_at.toISOString() : null,
    meetingName: row.meeting_name,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }
}

// Sales gets a real email the moment a lead comes in — no precedent for an
// admin-facing email existed in this codebase before this; scoped narrowly
// to just this one event rather than building a general admin-alert system.
// Fire-and-forget, matching notification.service.ts's own emailTo pattern —
// a slow/failed email must never fail the lead-creation request itself.
function notifyAdminOfNewLead(lead: Lead): void {
  if (!env.adminNotificationEmail) {
    log().info({ leadId: lead.id }, "new Full Custom lead (ADMIN_NOTIFICATION_EMAIL unset, not emailed)")
    return
  }
  void sendEmail({
    to: env.adminNotificationEmail,
    subject: `New Full Custom lead: ${lead.name}`,
    text: [
      `Name: ${lead.name}`,
      `Email: ${lead.email}`,
      `Phone: ${lead.phone}`,
      `Bots requested: ${lead.selectedBots.join(", ")}`,
      lead.userId ? `Existing account: ${lead.userId}` : "Not signed in at submission time",
    ].join("\n"),
  }).catch((err) => log().warn({ leadId: lead.id, err: err instanceof Error ? err.message : String(err) }, "admin lead-notification email failed"))
}

export async function getMyActiveLead(accessToken: string): Promise<Lead | null> {
  const userId = requireUserId(accessToken)
  setTenantContext({ scope: "user", userId })
  const db = requireDbPool()
  const { rows } = await db.query<LeadRow>(
    "select * from leads where user_id = $1 order by created_at desc limit 1",
    [userId],
  )
  return rows[0] ? rowToLead(rows[0]) : null
}

// Creates a new lead, or — if the caller is signed in and already has one
// active ("lead"-status, not yet booked) — updates that same row instead.
// This is the idempotency guarantee: a double-submit (network retry, a
// second tab) can never produce two lead rows for one account.
export async function createLead(accessTokenOrEmpty: string, input: CreateLeadInput): Promise<Lead> {
  const db = requireDbPool()
  const userId = await optionalUserId(accessTokenOrEmpty)
  if (userId) setTenantContext({ scope: "user", userId, userEmail: input.email })
  else setTenantContext({ scope: "public", userEmail: input.email })

  if (userId) {
    const { rows: existing } = await db.query<LeadRow>(
      "select * from leads where user_id = $1 and status = 'lead' order by created_at desc limit 1",
      [userId],
    )
    if (existing[0]) {
      const { rows } = await db.query<LeadRow>(
        `update leads set name = $2, email = $3, phone = $4, selected_bots = $5::jsonb, updated_at = now()
         where id = $1
         returning *`,
        [existing[0].id, input.name, input.email, input.phone, JSON.stringify(input.selectedBots)],
      )
      return rowToLead(rows[0])
    }
  }

  const { rows } = await db.query<LeadRow>(
    `insert into leads (user_id, name, email, phone, selected_bots)
     values ($1, $2, $3, $4, $5::jsonb)
     returning *`,
    [userId, input.name, input.email, input.phone, JSON.stringify(input.selectedBots)],
  )
  const lead = rowToLead(rows[0])
  notifyAdminOfNewLead(lead)
  return lead
}

export async function updateMyLead(accessToken: string, input: UpdateLeadInput): Promise<Lead> {
  const userId = requireUserId(accessToken)
  setTenantContext({ scope: "user", userId })
  const db = requireDbPool()

  const { rows: existing } = await db.query<LeadRow>(
    "select * from leads where user_id = $1 and status = 'lead' order by created_at desc limit 1",
    [userId],
  )
  const current = existing[0]
  if (!current) throw new AppError(404, "No active lead found for this account.")

  const { rows } = await db.query<LeadRow>(
    `update leads set name = $2, email = $3, phone = $4, selected_bots = $5::jsonb, updated_at = now()
     where id = $1
     returning *`,
    [current.id, input.name, input.email, input.phone, JSON.stringify(input.selectedBots)],
  )
  return rowToLead(rows[0])
}

// Used by the Calendly webhook, which only ever gives us the invitee's
// email — never our internal lead id — so matching by email (case
// insensitive) is the only option Calendly's payload actually supports.
// Logs rather than throws on no match: a webhook handler should still ack
// 200 so Calendly doesn't retry indefinitely against a booking we simply
// don't have a lead record for (e.g. someone booked without ever using
// the form).
export async function markLeadBookedByEmail(
  email: string,
  calendlyEventUri: string | null,
  meetingStartsAt: string | null,
  meetingName: string | null,
): Promise<void> {
  const db = requireDbPool()
  const { rows } = await db.query<{ id: string }>(
    `update leads set status = 'booked', calendly_event_uri = $2, meeting_starts_at = $3, meeting_name = $4, updated_at = now()
     where id = (
       select id from leads where lower(email) = lower($1) and status = 'lead'
       order by created_at desc limit 1
     )
     returning id`,
    [email, calendlyEventUri, meetingStartsAt, meetingName],
  )
  if (!rows[0]) {
    log().warn({ emailRef: shortRef(email.toLowerCase()) }, "Calendly booking webhook: no matching active lead found")
    return
  }
  log().info({ leadId: rows[0].id }, "lead marked booked via Calendly webhook")
}
