import { getStripeInboxHealth, listStripeInboxEvents } from "../stripeWebhookInbox.service.js"
import { requireAdminUserId } from "./adminAuth.service.js"
import { requireDbPool } from "./shared.js"

export interface ReservationHealth {
  staleHeldCount: number
}

// Should always read 0 — a non-zero count means the orphan-recovery sweep
// (worker.ts's "reservation-sweep-tick" job) isn't running or isn't
// keeping up, and is a real operational signal worth surfacing to admins
// rather than only ever being visible in a database console.
export async function getAdminReservationHealth(accessToken: string): Promise<ReservationHealth> {
  requireAdminUserId(accessToken)
  const db = requireDbPool()
  const { rows } = await db.query<{ count: string }>(
    "select count(*) as count from reservations where status = 'held' and expires_at < now()",
  )
  return { staleHeldCount: Number(rows[0]?.count) || 0 }
}

export async function getAdminStripeInbox(
  accessToken: string,
  query: { status?: string; type?: string; customer?: string; limit?: number; offset?: number } = {},
) {
  requireAdminUserId(accessToken)
  const status =
    query.status === "unprocessed" ||
    query.status === "processing" ||
    query.status === "failed" ||
    query.status === "processed"
      ? query.status
      : undefined
  const [health, listed] = await Promise.all([
    getStripeInboxHealth(),
    listStripeInboxEvents({
      status,
      type: query.type,
      customer: query.customer,
      limit: query.limit,
      offset: query.offset,
    }),
  ])
  return { health, ...listed }
}
