import { AppError } from "../../lib/errors.js"
import { runWithSystemContext } from "../../lib/tenantContext.js"
import { boundedPage } from "./adminManagement.service.js"
import { logAdminAction, requireDbPool } from "./shared.js"

// SA-01: super-admin-only, read-only views into one customer account
// (workspace members, invitations, chatbots) and the workspace list.
//
// - Every route that reaches this module is behind requireAdminAuth +
//   requireSuperAdmin.
// - Queries run in the system context (CS-15): workspace_members /
//   workspace_invitations are RLS-scoped to the owner or a member, so only the
//   privileged login sees them across tenants.
// - Invitations never expose token_hash (or any token-derived value): the
//   select lists name the returned columns explicitly.
// - Every view is written to admin_audit_log, with the customer account as
//   target_user_id.

async function assertCustomerExists(userId: string): Promise<{ email: string }> {
  const db = requireDbPool()
  const { rows } = await runWithSystemContext(() =>
    db.query<{ email: string }>("select email from users where id = $1", [userId]),
  )
  if (!rows[0]) throw new AppError(404, "User not found.")
  return rows[0]
}

export interface AccountMember {
  userId: string
  email: string
  name: string
  role: "admin" | "viewer"
  joinedAt: string
}

export interface AccountInvitation {
  id: string
  email: string
  role: "admin" | "viewer"
  status: "pending" | "expired"
  invitedAt: string
  expiresAt: string
}

export async function getAccountMembers(
  actorId: string,
  ownerUserId: string,
  limit?: number,
  offset?: number,
): Promise<{
  owner: { id: string; email: string }
  members: AccountMember[]
  memberCount: number
  invitations: AccountInvitation[]
  invitationCount: number
}> {
  const owner = await assertCustomerExists(ownerUserId)
  const db = requireDbPool()
  const page = boundedPage(limit, offset)

  const result = await runWithSystemContext(async () => {
    const memberCount = await db.query<{ total: number }>(
      "select count(*)::int as total from workspace_members where owner_user_id = $1",
      [ownerUserId],
    )
    const members = await db.query<{ member_user_id: string; email: string; name: string; role: string; created_at: Date }>(
      `select wm.member_user_id, u.email, u.name, wm.role, wm.created_at
         from workspace_members wm
         join users u on u.id = wm.member_user_id
        where wm.owner_user_id = $1
        order by wm.created_at asc, wm.id asc
        limit $2 offset $3`,
      [ownerUserId, page.limit, page.offset],
    )
    // Pending invitations, including pending ones past expires_at (reported as
    // "expired") and ones already marked expired. Accepted/revoked are history.
    const invitationCount = await db.query<{ total: number }>(
      `select count(*)::int as total from workspace_invitations
        where owner_user_id = $1 and status in ('pending', 'expired')`,
      [ownerUserId],
    )
    const invitations = await db.query<{
      id: string
      email: string
      role: string
      effective_status: string
      created_at: Date
      expires_at: Date
    }>(
      `select id, email, role,
              case when status = 'pending' and expires_at > now() then 'pending' else 'expired' end as effective_status,
              created_at, expires_at
         from workspace_invitations
        where owner_user_id = $1 and status in ('pending', 'expired')
        order by created_at desc, id desc
        limit $2 offset $3`,
      [ownerUserId, page.limit, page.offset],
    )
    return { memberCount, members, invitationCount, invitations }
  })

  await logAdminAction(actorId, "view_account_members", ownerUserId, page)

  return {
    owner: { id: ownerUserId, email: owner.email },
    members: result.members.rows.map((r) => ({
      userId: r.member_user_id,
      email: r.email,
      name: r.name,
      role: r.role === "admin" ? "admin" : "viewer",
      joinedAt: r.created_at.toISOString(),
    })),
    memberCount: result.memberCount.rows[0]?.total ?? 0,
    invitations: result.invitations.rows.map((r) => ({
      id: r.id,
      email: r.email,
      role: r.role === "admin" ? "admin" : "viewer",
      status: r.effective_status === "pending" ? "pending" : "expired",
      invitedAt: r.created_at.toISOString(),
      expiresAt: r.expires_at.toISOString(),
    })),
    invitationCount: result.invitationCount.rows[0]?.total ?? 0,
  }
}

export interface AccountChatbot {
  id: string
  name: string
  createdAt: string
  status: string
  isActive: boolean
  documentCount: number
}

export async function getAccountChatbots(
  actorId: string,
  ownerUserId: string,
  limit?: number,
  offset?: number,
): Promise<{ chatbots: AccountChatbot[]; totalCount: number }> {
  await assertCustomerExists(ownerUserId)
  const db = requireDbPool()
  const page = boundedPage(limit, offset)

  const { rows, total } = await runWithSystemContext(async () => {
    const count = await db.query<{ total: number }>("select count(*)::int as total from chatbots where user_id = $1", [
      ownerUserId,
    ])
    const list = await db.query<{
      id: string
      name: string
      created_at: Date
      status: string
      is_active: boolean
      document_count: number
    }>(
      `select c.id, c.name, c.created_at, c.status, c.is_active,
              (select count(*)::int from chatbot_documents d where d.chatbot_id = c.id) as document_count
         from chatbots c
        where c.user_id = $1
        order by c.created_at desc, c.id desc
        limit $2 offset $3`,
      [ownerUserId, page.limit, page.offset],
    )
    return { rows: list.rows, total: count.rows[0]?.total ?? 0 }
  })

  await logAdminAction(actorId, "view_account_chatbots", ownerUserId, page)

  return {
    chatbots: rows.map((r) => ({
      id: r.id,
      name: r.name,
      createdAt: r.created_at.toISOString(),
      status: r.status,
      isActive: r.is_active,
      documentCount: Number(r.document_count || 0),
    })),
    totalCount: total,
  }
}

export interface WorkspaceListItem {
  ownerUserId: string
  email: string
  name: string
  isActive: boolean
  createdAt: string
  memberCount: number
  pendingInvitationCount: number
  chatbotCount: number
  /** Set when this account is itself a member of another account's workspace. */
  memberOfOwnerUserId: string | null
}

export async function listWorkspaces(
  actorId: string,
  search?: string,
  limit?: number,
  offset?: number,
): Promise<{ workspaces: WorkspaceListItem[]; totalCount: number }> {
  const db = requireDbPool()
  const page = boundedPage(limit, offset)
  const term = search?.trim().toLowerCase().slice(0, 200) || ""
  // Escape LIKE wildcards so a search for "_" or "%" is literal.
  const pattern = term ? `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null

  const { rows, total } = await runWithSystemContext(async () => {
    const count = await db.query<{ total: number }>(
      `select count(*)::int as total from users u
        where $1::text is null or lower(u.email) like $1 or lower(u.name) like $1`,
      [pattern],
    )
    const list = await db.query<{
      id: string
      email: string
      name: string
      is_active: boolean
      trial_started_at: Date
      member_count: number
      pending_invitation_count: number
      chatbot_count: number
      member_of: string | null
    }>(
      `select u.id, u.email, u.name, u.is_active, u.trial_started_at,
              (select count(*)::int from workspace_members wm where wm.owner_user_id = u.id) as member_count,
              (select count(*)::int from workspace_invitations wi
                 where wi.owner_user_id = u.id and wi.status = 'pending' and wi.expires_at > now()) as pending_invitation_count,
              (select count(*)::int from chatbots c where c.user_id = u.id) as chatbot_count,
              (select wm.owner_user_id from workspace_members wm where wm.member_user_id = u.id) as member_of
         from users u
        where $1::text is null or lower(u.email) like $1 or lower(u.name) like $1
        order by u.trial_started_at desc, u.id desc
        limit $2 offset $3`,
      [pattern, page.limit, page.offset],
    )
    return { rows: list.rows, total: count.rows[0]?.total ?? 0 }
  })

  await logAdminAction(actorId, "list_workspaces", null, { ...page, searched: Boolean(term) })

  return {
    workspaces: rows.map((r) => ({
      ownerUserId: r.id,
      email: r.email,
      name: r.name,
      isActive: r.is_active,
      createdAt: r.trial_started_at.toISOString(),
      memberCount: Number(r.member_count || 0),
      pendingInvitationCount: Number(r.pending_invitation_count || 0),
      chatbotCount: Number(r.chatbot_count || 0),
      memberOfOwnerUserId: r.member_of,
    })),
    totalCount: total,
  }
}
