import { pool } from "./db.js"
import { AppError } from "./errors.js"
import { runWithTenantContext, setTenantContext } from "./tenantContext.js"

// v1 ships 3 roles. "owner" is never a workspace_members row — it's
// whoever's user_id the workspace is keyed by (chatbots.user_id /
// subscriptions.user_id), exactly as before Phase 2. A member is always
// 'admin' or 'viewer'. Agent is deferred until there's a conversation inbox
// for it to scope to (see Phase 2 audit).
export type MemberRole = "admin" | "viewer"
export type EffectiveRole = "owner" | MemberRole

const ROLE_RANK: Record<EffectiveRole, number> = { viewer: 0, admin: 1, owner: 2 }

export interface TenantContext {
  /** Whose chatbots/subscription this request actually operates on. */
  tenantUserId: string
  /** Who is actually making the request — never substitute tenantUserId for this in an audit log. */
  actorUserId: string
  role: EffectiveRole
}

function requireDbPool() {
  if (!pool) throw new AppError(503, "Database is not configured. Set DATABASE_URL and JWT_SECRET.")
  return pool
}

function roleLabel(role: EffectiveRole): string {
  return role.charAt(0).toUpperCase() + role.slice(1)
}

// A user is a member of at most one workspace at a time (v1 — "one
// membership per user"), enforced by workspace_members.member_user_id being
// unique. If there's no row, the caller owns their own workspace, exactly
// as every chatbot-ownership check worked before Phase 2.
//
// CS-15: workspace_members is RLS-protected (owner or member only), so the
// lookup runs in its own context bound to the actor. That keeps it correct
// whatever context the caller is in (none, a worker, the owner's) and leaves
// the caller's context untouched. A hidden membership row here would make a
// member look like an owner to requireRealAccountOwner.
async function findMembership(actorUserId: string): Promise<{ ownerUserId: string; role: MemberRole } | null> {
  const db = requireDbPool()
  const { rows } = await runWithTenantContext({ scope: "user", userId: actorUserId }, () =>
    db.query<{ owner_user_id: string; role: MemberRole }>(
      `select owner_user_id, role from workspace_members where member_user_id = $1`,
      [actorUserId],
    ),
  )
  const row = rows[0]
  return row ? { ownerUserId: row.owner_user_id, role: row.role } : null
}

// The one place every ownership check in the app routes through. Resolves
// which real account (tenantUserId) the caller is allowed to act on, and at
// what role, throwing 403 if that role doesn't meet requiredRole. No call
// site can obtain a tenant id without stating what it needs for.
//
// This intentionally never touches db/rls.sql itself: Postgres RLS still
// only ever sees tenantUserId (the real owner) as app.user_id — a member's
// request is, from the database's point of view, indistinguishable from the
// owner's. All entitlement / plan-cap / cost-cap / reservation lookups are
// already keyed by chatbotId -> chatbots.user_id internally
// (billing.service.ts, usage.service.ts), not by whatever user_id the
// caller happens to be, so they inherit this for free as long as app.user_id
// is the resolved tenant.
//
// setTenantContext is called unconditionally here (both branches), not just
// for a resolved membership — this function is the one place that decides
// the tenant, so it must not depend on bindTenantContext (tenantContext
// middleware, which sets app.user_id from the RAW token before any service
// code runs) having already set the right value, or having run at all. In
// the HTTP path the two happen to agree for a plain owner (no membership ==
// actorUserId == tenantUserId already), but any caller that reaches this
// function outside that middleware — a worker, a script, a test calling it
// directly — would otherwise see RLS silently return zero rows.
//
// The GUC itself is applied by db.ts's query wrapper via set_config(key,
// value, true) — transaction-local (SET LOCAL), inside a BEGIN/COMMIT around
// every pool.query() call (or around the active explicit transaction) — and
// is gone the instant that transaction ends and the connection returns to
// the pool. Never a session-level SET on a connection another request could
// later reuse. See tests/integration/postgresRls.integration.test.ts for
// the concurrent-tenant and no-session-leak proofs.
export async function resolveTenantContext(actorUserId: string, requiredRole: EffectiveRole): Promise<TenantContext> {
  const membership = await findMembership(actorUserId)
  if (!membership) {
    setTenantContext({ scope: "user", userId: actorUserId })
    return { tenantUserId: actorUserId, actorUserId, role: "owner" }
  }
  if (ROLE_RANK[membership.role] < ROLE_RANK[requiredRole]) {
    throw new AppError(403, `This action requires ${roleLabel(requiredRole)} access.`)
  }
  setTenantContext({ scope: "user", userId: membership.ownerUserId })
  return { tenantUserId: membership.ownerUserId, actorUserId, role: membership.role }
}

// For the handful of routes that are deliberately owner-only no matter what
// role a membership would otherwise grant (billing, password/email change,
// account deletion, member invites/removal/role changes, API keys) — see
// Phase 2 audit condition 2. These never resolve a membership at all: a
// member, even one with the "admin" role, cannot act as the real account
// owner for these. Throws if the caller is themselves a member of someone
// else's workspace.
export async function requireRealAccountOwner(actorUserId: string): Promise<string> {
  const membership = await findMembership(actorUserId)
  if (membership) {
    throw new AppError(403, "This action is only available to the account owner.")
  }
  return actorUserId
}

export async function getActiveMembership(memberUserId: string): Promise<{ ownerUserId: string; role: MemberRole } | null> {
  return findMembership(memberUserId)
}
