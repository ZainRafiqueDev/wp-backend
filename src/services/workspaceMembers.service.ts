import { verifyAccessToken } from "../lib/auth.js"
import { pool } from "../lib/db.js"
import { AppError } from "../lib/errors.js"
import { sendEmail } from "../lib/email.js"
import { env } from "../env.js"
import { getActiveMembership, requireRealAccountOwner, resolveTenantContext, type MemberRole } from "../lib/tenancy.js"
import { setTenantContext } from "../lib/tenantContext.js"
import { getEntitlementForUser } from "./billing.service.js"
import { generateOpaqueToken, hashToken } from "./notification.service.js"

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000

function requireDbPool() {
  if (!pool) throw new AppError(503, "Database is not configured. Set DATABASE_URL and JWT_SECRET.")
  return pool
}

function requireUserId(accessToken: string): string {
  const userId = verifyAccessToken(accessToken)
  if (!userId) throw new AppError(401, "Please sign in again.")
  return userId
}

// CS-11: inviting and accepting need a verified email. An unverified account
// may have been pre-registered by someone who does not own the address
// (CS-05); without this they could invite a second account of their own and
// keep access to the workspace after the real owner takes the address back.
async function requireVerifiedEmail(userId: string, message: string): Promise<void> {
  const { rows } = await requireDbPool().query<{ email_verified: boolean }>(
    "select email_verified from users where id = $1",
    [userId],
  )
  if (!rows[0]?.email_verified) throw new AppError(403, message)
}

type Queryable = { query: (text: string, values?: unknown[]) => Promise<{ rowCount: number | null }> }

/**
 * CS-11 / CS-05 follow-up: called (inside the link transaction) when an
 * unverified account is linked to the Google identity that proves who really
 * owns the address. Whatever workspace access the unverified account created
 * is undone: members it added to its own workspace, its pending invitations,
 * and any membership it holds in someone else's workspace. The owner can
 * re-invite whoever they actually want once signed in.
 */
export async function removeMembershipsOfUnverifiedAccount(db: Queryable, userId: string): Promise<void> {
  const members = await db.query("delete from workspace_members where owner_user_id = $1", [userId])
  const invites = await db.query(
    `update workspace_invitations set status = 'revoked', revoked_at = now()
     where owner_user_id = $1 and status = 'pending'`,
    [userId],
  )
  const joined = await db.query("delete from workspace_members where member_user_id = $1", [userId])
  if (members.rowCount || invites.rowCount || joined.rowCount) {
    await db.query(
      `insert into workspace_audit_log (owner_user_id, actor_user_id, action, detail) values ($1, $1, $2, $3)`,
      [
        userId,
        "unverified_account_memberships_removed",
        JSON.stringify({ membersRemoved: members.rowCount ?? 0, invitationsRevoked: invites.rowCount ?? 0, membershipsLeft: joined.rowCount ?? 0 }),
      ],
    )
  }
}

export interface WorkspaceMember {
  userId: string
  email: string
  name: string
  role: "owner" | MemberRole
  joinedAt: string
}

export interface WorkspaceInvitation {
  id: string
  email: string
  role: MemberRole
  status: "pending" | "accepted" | "revoked" | "expired"
  expiresAt: string
  createdAt: string
}

export interface WorkspaceMembersResult {
  members: WorkspaceMember[]
  invitations: WorkspaceInvitation[]
  seats: { used: number; max: number }
}

function mapInvitation(row: {
  id: string
  email: string
  role: string
  status: string
  expires_at: Date
  created_at: Date
}): WorkspaceInvitation {
  return {
    id: row.id,
    email: row.email,
    role: row.role as MemberRole,
    status: row.status as WorkspaceInvitation["status"],
    expiresAt: row.expires_at.toISOString(),
    createdAt: row.created_at.toISOString(),
  }
}

// Separate from admin_audit_log (platform-admin actions) — always records
// the real actor, never the resolved tenant/owner, so "who actually did
// this" survives even when a member acted on the owner's behalf.
async function writeWorkspaceAuditLog(ownerUserId: string, actorUserId: string, action: string, detail: Record<string, unknown>) {
  await requireDbPool().query(
    `insert into workspace_audit_log (owner_user_id, actor_user_id, action, detail) values ($1, $2, $3, $4)`,
    [ownerUserId, actorUserId, action, JSON.stringify(detail)],
  )
}

// List members = Admin+ (owner or admin-role member can see the roster;
// viewers cannot).
export async function listMembers(accessToken: string): Promise<WorkspaceMembersResult> {
  const db = requireDbPool()
  const actorUserId = requireUserId(accessToken)
  const { tenantUserId } = await resolveTenantContext(actorUserId, "admin")

  const entitlement = await getEntitlementForUser(tenantUserId)

  const { rows: ownerRows } = await db.query<{ id: string; email: string; name: string; created_at: Date }>(
    `select id, email, name, created_at from users where id = $1`,
    [tenantUserId],
  )
  const owner = ownerRows[0]
  if (!owner) throw new AppError(404, "Account not found.")

  const { rows: memberRows } = await db.query<{ member_user_id: string; email: string; name: string; role: string; created_at: Date }>(
    `select wm.member_user_id, u.email, u.name, wm.role, wm.created_at
     from workspace_members wm join users u on u.id = wm.member_user_id
     where wm.owner_user_id = $1 order by wm.created_at asc`,
    [tenantUserId],
  )

  const { rows: inviteRows } = await db.query<{
    id: string
    email: string
    role: string
    status: string
    expires_at: Date
    created_at: Date
  }>(
    `select id, email, role, status, expires_at, created_at
     from workspace_invitations where owner_user_id = $1 and status = 'pending'
     order by created_at desc`,
    [tenantUserId],
  )

  const members: WorkspaceMember[] = [
    { userId: owner.id, email: owner.email, name: owner.name, role: "owner", joinedAt: owner.created_at.toISOString() },
    ...memberRows.map((row) => ({
      userId: row.member_user_id,
      email: row.email,
      name: row.name,
      role: row.role as MemberRole,
      joinedAt: row.created_at.toISOString(),
    })),
  ]

  return {
    members,
    invitations: inviteRows.map(mapInvitation),
    // Pending invites hold a seat — inviteMember enforces the limit on
    // members + pending, so the count shown here must match or the dashboard
    // shows free seats that inviting then refuses.
    seats: { used: members.length + inviteRows.length, max: entitlement.maxSeats },
  }
}

export interface InviteMemberInput {
  email: string
  role: MemberRole
}

// Owner-only (condition 2 / Phase 2 approval item 4) — a team "admin" role
// member cannot invite, remove, or change roles, even though they can list
// members. Never resolves through membership at all.
export async function inviteMember(accessToken: string, input: InviteMemberInput): Promise<WorkspaceInvitation> {
  const db = requireDbPool()
  const actorUserId = requireUserId(accessToken)
  const ownerUserId = await requireRealAccountOwner(actorUserId)
  await requireVerifiedEmail(actorUserId, "Verify your email address before inviting team members.")
  const normalizedEmail = input.email.toLowerCase().trim()

  const { rows: ownerRows } = await db.query<{ email: string }>(`select email from users where id = $1`, [ownerUserId])
  if (ownerRows[0]?.email.toLowerCase() === normalizedEmail) {
    throw new AppError(400, "You can't invite yourself.")
  }

  const entitlement = await getEntitlementForUser(ownerUserId)
  const { rows: usageRows } = await db.query<{ members: string; pending_invites: string }>(
    `select
       (select count(*) from workspace_members where owner_user_id = $1) as members,
       (select count(*) from workspace_invitations
         where owner_user_id = $1 and status = 'pending' and lower(email) <> $2) as pending_invites`,
    [ownerUserId, normalizedEmail],
  )
  // A pending invite to this same email is replaced below rather than
  // stacked, so it doesn't count against the seat it's about to reuse.
  const seatsUsed = 1 + Number(usageRows[0].members) + Number(usageRows[0].pending_invites)
  if (seatsUsed >= entitlement.maxSeats) {
    throw new AppError(409, `You've reached your plan's ${entitlement.maxSeats}-seat limit. Remove a member or revoke a pending invite to free a seat, or upgrade your plan.`)
  }

  const { rows: targetUserRows } = await db.query<{ id: string }>(`select id from users where email = $1`, [normalizedEmail])
  if (targetUserRows[0]) {
    const existingMembership = await getActiveMembership(targetUserRows[0].id)
    if (existingMembership) {
      throw new AppError(409, "This person is already a member of a workspace.")
    }
  }

  // Replace any existing pending invite to the same email rather than stacking duplicates.
  await db.query(
    `update workspace_invitations set status = 'revoked', revoked_at = now()
     where owner_user_id = $1 and lower(email) = $2 and status = 'pending'`,
    [ownerUserId, normalizedEmail],
  )

  const token = generateOpaqueToken()
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS)
  const { rows } = await db.query<{ id: string; email: string; role: string; status: string; expires_at: Date; created_at: Date }>(
    `insert into workspace_invitations (owner_user_id, email, role, token_hash, invited_by, expires_at)
     values ($1, $2, $3, $4, $5, $6)
     returning id, email, role, status, expires_at, created_at`,
    [ownerUserId, normalizedEmail, input.role, hashToken(token), actorUserId, expiresAt],
  )

  await writeWorkspaceAuditLog(ownerUserId, actorUserId, "member_invited", { email: normalizedEmail, role: input.role })

  const link = `${env.frontendUrl.replace(/\/$/, "")}/invite/accept?token=${token}`
  await sendEmail({
    to: normalizedEmail,
    subject: "You've been invited to a Chatmate360 workspace",
    text: `You've been invited to join a Chatmate360 workspace as ${input.role}.\n\nAccept the invite:\n\n${link}\n\nThis link expires in 7 days.`,
  })

  return mapInvitation(rows[0])
}

export async function revokeInvitation(accessToken: string, invitationId: string): Promise<void> {
  const db = requireDbPool()
  const actorUserId = requireUserId(accessToken)
  const ownerUserId = await requireRealAccountOwner(actorUserId)

  const { rowCount } = await db.query(
    `update workspace_invitations set status = 'revoked', revoked_at = now()
     where id = $1 and owner_user_id = $2 and status = 'pending'`,
    [invitationId, ownerUserId],
  )
  if (!rowCount) throw new AppError(404, "Invitation not found.")
  await writeWorkspaceAuditLog(ownerUserId, actorUserId, "invitation_revoked", { invitationId })
}

export async function resendInvitation(accessToken: string, invitationId: string): Promise<WorkspaceInvitation> {
  const db = requireDbPool()
  const actorUserId = requireUserId(accessToken)
  const ownerUserId = await requireRealAccountOwner(actorUserId)
  await requireVerifiedEmail(actorUserId, "Verify your email address before inviting team members.")

  const expiresAt = new Date(Date.now() + INVITE_TTL_MS)
  const token = generateOpaqueToken()
  const { rows } = await db.query<{ id: string; email: string; role: string; status: string; expires_at: Date; created_at: Date }>(
    `update workspace_invitations set token_hash = $1, expires_at = $2
     where id = $3 and owner_user_id = $4 and status = 'pending'
     returning id, email, role, status, expires_at, created_at`,
    [hashToken(token), expiresAt, invitationId, ownerUserId],
  )
  const invitation = rows[0]
  if (!invitation) throw new AppError(404, "Invitation not found.")

  const link = `${env.frontendUrl.replace(/\/$/, "")}/invite/accept?token=${token}`
  await sendEmail({
    to: invitation.email,
    subject: "You've been invited to a Chatmate360 workspace",
    text: `You've been invited to join a Chatmate360 workspace as ${invitation.role}.\n\nAccept the invite:\n\n${link}\n\nThis link expires in 7 days.`,
  })
  await writeWorkspaceAuditLog(ownerUserId, actorUserId, "invitation_resent", { invitationId })

  return mapInvitation(invitation)
}

export async function removeMember(accessToken: string, memberUserId: string): Promise<void> {
  const db = requireDbPool()
  const actorUserId = requireUserId(accessToken)
  const ownerUserId = await requireRealAccountOwner(actorUserId)

  const { rowCount } = await db.query(
    `delete from workspace_members where owner_user_id = $1 and member_user_id = $2`,
    [ownerUserId, memberUserId],
  )
  if (!rowCount) throw new AppError(404, "Member not found.")
  await writeWorkspaceAuditLog(ownerUserId, actorUserId, "member_removed", { memberUserId })
}

export async function changeMemberRole(accessToken: string, memberUserId: string, role: MemberRole): Promise<WorkspaceMember> {
  const db = requireDbPool()
  const actorUserId = requireUserId(accessToken)
  const ownerUserId = await requireRealAccountOwner(actorUserId)

  const { rows } = await db.query<{ member_user_id: string; email: string; name: string; role: string; created_at: Date }>(
    `update workspace_members wm set role = $1
     from users u
     where wm.owner_user_id = $2 and wm.member_user_id = $3 and u.id = wm.member_user_id
     returning wm.member_user_id, u.email, u.name, wm.role, wm.created_at`,
    [role, ownerUserId, memberUserId],
  )
  const row = rows[0]
  if (!row) throw new AppError(404, "Member not found.")
  await writeWorkspaceAuditLog(ownerUserId, actorUserId, "member_role_changed", { memberUserId, role })

  return { userId: row.member_user_id, email: row.email, name: row.name, role: row.role as MemberRole, joinedAt: row.created_at.toISOString() }
}

// v1 restriction (Phase 2 approval condition 5): an invite can't be
// accepted by a user who already owns chatbots or a subscription — joining
// a workspace as a member and being an account owner yourself are mutually
// exclusive in v1 (see resolveTenantContext's "one membership per user").
export async function acceptInvitation(accessToken: string, token: string): Promise<{ ownerUserId: string; role: MemberRole }> {
  const db = requireDbPool()
  const actorUserId = requireUserId(accessToken)
  await requireVerifiedEmail(actorUserId, "Verify your email address before accepting a workspace invitation.")
  // CS-15 (B02-008): workspace_invitations / workspace_members RLS lets a
  // signed-in invitee see and accept only the one invitation whose token they
  // present, and add only themselves to that owner's workspace.
  setTenantContext({ scope: "user", userId: actorUserId, lookupHash: hashToken(token) })

  const { rows } = await db.query<{
    id: string
    owner_user_id: string
    email: string
    role: string
    status: string
    expires_at: Date
  }>(
    `select id, owner_user_id, email, role, status, expires_at from workspace_invitations where token_hash = $1`,
    [hashToken(token)],
  )
  const invite = rows[0]
  if (!invite) throw new AppError(404, "Invitation not found.")
  if (invite.status === "accepted") throw new AppError(409, "This invitation has already been accepted.")
  if (invite.status === "revoked") throw new AppError(409, "This invitation was revoked.")
  if (invite.status === "expired" || invite.expires_at < new Date()) {
    await db.query(`update workspace_invitations set status = 'expired' where id = $1`, [invite.id])
    throw new AppError(409, "This invitation has expired. Ask the workspace owner to resend it.")
  }

  const { rows: actorRows } = await db.query<{ email: string }>(`select email from users where id = $1`, [actorUserId])
  if (actorRows[0]?.email.toLowerCase() !== invite.email.toLowerCase()) {
    throw new AppError(403, "This invitation was sent to a different email address. Sign in with that email to accept it.")
  }

  const { rows: chatbotCountRows } = await db.query<{ n: string }>(`select count(*)::text as n from chatbots where user_id = $1`, [actorUserId])
  if (Number(chatbotCountRows[0].n) > 0) {
    throw new AppError(409, "This account already owns chatbots. Invitations can only be accepted by a brand-new account with no chatbots or subscription.")
  }
  const { rows: subRows } = await db.query(`select 1 from subscriptions where user_id = $1`, [actorUserId])
  if (subRows[0]) {
    throw new AppError(409, "This account already has a subscription. Invitations can only be accepted by a brand-new account with no chatbots or subscription.")
  }
  const existingMembership = await getActiveMembership(actorUserId)
  if (existingMembership) {
    throw new AppError(409, "This account is already a member of another workspace.")
  }

  const client = await db.connect()
  try {
    await client.query("begin")
    // Accept first: workspace_members RLS (CS-15) only lets the invitee add
    // itself for an invitation accepted in this same transaction.
    await client.query(`update workspace_invitations set status = 'accepted', accepted_at = now() where id = $1`, [invite.id])
    await client.query(
      `insert into workspace_members (owner_user_id, member_user_id, role, invited_by) values ($1, $2, $3, $4)`,
      [invite.owner_user_id, actorUserId, invite.role, invite.owner_user_id],
    )
    await client.query("commit")
  } catch (err) {
    await client.query("rollback").catch(() => undefined)
    throw err
  } finally {
    client.release()
  }

  await writeWorkspaceAuditLog(invite.owner_user_id, actorUserId, "member_joined", { role: invite.role })
  return { ownerUserId: invite.owner_user_id, role: invite.role as MemberRole }
}
