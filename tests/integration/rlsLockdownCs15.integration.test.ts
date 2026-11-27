// CS-15 negative RLS tests (B02-005, B02-008, B02-009, B09-017).
// Every fixture is a fresh, uniquely named tenant; nothing is truncated.
import { createHash, randomUUID } from "node:crypto"

import { describe, expect, it } from "vitest"

import { pool } from "../../src/lib/db.js"
import * as tenantContext from "../../src/lib/tenantContext.js"
import { runWithTenantContext } from "../../src/lib/tenantContext.js"
import { seedOwnedChatbot, type SeededTenant } from "../helpers/seedTenant.js"

function db() {
  if (!pool) throw new Error("pool required")
  return pool
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex")

async function seedAttachment(tenant: SeededTenant): Promise<string> {
  const conv = await db().query<{ id: string }>(
    `insert into conversations (chatbot_id, session_id) values ($1, $2) returning id`,
    [tenant.chatbotId, `cs15-${randomUUID()}`],
  )
  const att = await db().query<{ id: string }>(
    `insert into chatbot_attachments
       (chatbot_id, conversation_id, storage_key, generated_file_name, original_file_name, content_type, file_size, status, expires_at)
     values ($1, $2, $3, 'gen.pdf', 'tenant-a-secret.pdf', 'application/pdf', 10, 'clean', now() + interval '1 day')
     returning id`,
    [tenant.chatbotId, conv.rows[0].id, `cs15/${randomUUID()}`],
  )
  return att.rows[0].id
}

async function seedWorkspace(owner: SeededTenant) {
  const member = await seedOwnedChatbot("cs15-member", "free")
  await db().query(
    `insert into workspace_members (owner_user_id, member_user_id, role, invited_by) values ($1, $2, 'viewer', $1)`,
    [owner.userId, member.userId],
  )
  const rawToken = `cs15-invite-${randomUUID()}`
  const invite = await db().query<{ id: string }>(
    `insert into workspace_invitations (owner_user_id, email, role, token_hash, invited_by, expires_at)
     values ($1, $2, 'viewer', $3, $1, now() + interval '1 day') returning id`,
    [owner.userId, `cs15-invitee-${randomUUID()}@example.test`, sha256(rawToken)],
  )
  await db().query(
    `insert into workspace_audit_log (owner_user_id, actor_user_id, action) values ($1, $1, 'cs15_probe')`,
    [owner.userId],
  )
  await db().query(`insert into attachment_storage_usage (owner_user_id, bytes_used) values ($1, 4242)`, [owner.userId])
  return { member, rawToken, inviteId: invite.rows[0].id }
}

function asUser<T>(tenant: SeededTenant, fn: () => Promise<T>, extra: tenantContext.TenantContext = {}) {
  return runWithTenantContext({ scope: "user", userId: tenant.userId, chatbotId: tenant.chatbotId, ...extra }, fn)
}

async function expectDenied(promise: Promise<unknown>) {
  await expect(promise).rejects.toMatchObject({ code: "42501" })
}

describe("CS-15 B02-009: privileged scope cannot be self-set on the tenant login", () => {
  it("set_config('app.scope','system') on chatmate360_app does not expose another tenant's chatbot", async () => {
    const a = await seedOwnedChatbot("cs15-priv-a")
    const b = await seedOwnedChatbot("cs15-priv-b")

    const seen = await asUser(b, async () => {
      const client = await db().connect()
      try {
        await client.query("begin")
        const role = await client.query<{ current_user: string }>("select current_user")
        await client.query("select set_config('app.scope', 'system', true)")
        const bots = await client.query("select id from chatbots where id = $1", [a.chatbotId])
        const users = await client.query("select id from users where id = $1", [a.userId])
        await client.query("rollback")
        return { role: role.rows[0].current_user, bots: bots.rowCount, users: users.rowCount }
      } finally {
        client.release()
      }
    })

    expect(seen.role).toBe("chatmate360_app")
    expect(seen.bots).toBe(0)
    expect(seen.users).toBe(0)
  })

  it("admin/system scope still works, on the separate chatmate360_system login", async () => {
    const a = await seedOwnedChatbot("cs15-sys-a")
    const result = await tenantContext.runWithSystemContext(async () => {
      const role = await db().query<{ current_user: string }>("select current_user")
      const bots = await db().query("select id from chatbots where id = $1", [a.chatbotId])
      return { role: role.rows[0].current_user, bots: bots.rowCount }
    })
    expect(result).toEqual({ role: "chatmate360_system", bots: 1 })
  })

  it("a public-scope context cannot rewrite chatbots.user_id to take over a chatbot", async () => {
    const victim = await seedOwnedChatbot("cs15-freeze-victim")
    const attacker = await seedOwnedChatbot("cs15-freeze-attacker")

    await runWithTenantContext({ scope: "public", chatbotId: victim.chatbotId }, async () => {
      await expectDenied(db().query("update chatbots set user_id = $1 where id = $2", [attacker.userId, victim.chatbotId]))
    })
    const { rows } = await db().query<{ user_id: string }>("select user_id from chatbots where id = $1", [victim.chatbotId])
    expect(rows[0].user_id).toBe(victim.userId)
  })
})

describe("CS-15 B02-005: tenant login has no CREATE privilege", () => {
  it("chatmate360_app cannot create on the database or schema public", async () => {
    const a = await seedOwnedChatbot("cs15-create")
    const privs = await asUser(a, async () => {
      const { rows } = await db().query<{ db: boolean; schema: boolean }>(
        `select has_database_privilege(current_user, current_database(), 'CREATE') as db,
                has_schema_privilege(current_user, 'public', 'CREATE') as schema`,
      )
      return rows[0]
    })
    expect(privs).toEqual({ db: false, schema: false })
  })
})

describe("CS-15 B02-008: tenant A's attachment and workspace rows are invisible and immutable to tenant B", () => {
  it("chatbot_attachments", async () => {
    const a = await seedOwnedChatbot("cs15-att-a")
    const b = await seedOwnedChatbot("cs15-att-b")
    const attachmentId = await seedAttachment(a)
    const conv = await db().query<{ id: string }>(`select conversation_id as id from chatbot_attachments where id = $1`, [attachmentId])

    await asUser(b, async () => {
      const all = await db().query<{ id: string }>("select id from chatbot_attachments")
      expect(all.rows.map((r) => r.id)).not.toContain(attachmentId)
      const upd = await db().query("update chatbot_attachments set status = 'denied' where id = $1", [attachmentId])
      expect(upd.rowCount).toBe(0)
      const del = await db().query("delete from chatbot_attachments where id = $1", [attachmentId])
      expect(del.rowCount).toBe(0)
      await expectDenied(
        db().query(
          `insert into chatbot_attachments
             (chatbot_id, conversation_id, storage_key, generated_file_name, original_file_name, content_type, file_size, expires_at)
           values ($1, $2, 'x', 'x', 'x', 'text/plain', 1, now())`,
          [a.chatbotId, conv.rows[0].id],
        ),
      )
    })
    // Public widget of tenant B sees none either; tenant A's own context does.
    const publicB = await runWithTenantContext({ scope: "public", chatbotId: b.chatbotId }, () =>
      db().query("select id from chatbot_attachments where id = $1", [attachmentId]),
    )
    expect(publicB.rowCount).toBe(0)
    const own = await asUser(a, () => db().query("select status from chatbot_attachments where id = $1", [attachmentId]))
    expect(own.rows[0]?.status).toBe("clean")
  })

  it("attachment_storage_usage", async () => {
    const a = await seedOwnedChatbot("cs15-asu-a")
    const b = await seedOwnedChatbot("cs15-asu-b")
    await seedWorkspace(a)

    await asUser(b, async () => {
      const all = await db().query<{ owner_user_id: string }>("select owner_user_id from attachment_storage_usage")
      expect(all.rows.map((r) => r.owner_user_id)).not.toContain(a.userId)
      const upd = await db().query("update attachment_storage_usage set bytes_used = 0 where owner_user_id = $1", [a.userId])
      expect(upd.rowCount).toBe(0)
    })
    // Tenant B's public widget cannot reach tenant A's counter either.
    await runWithTenantContext({ scope: "public", chatbotId: b.chatbotId }, async () => {
      const upd = await db().query("update attachment_storage_usage set bytes_used = 0 where owner_user_id = $1", [a.userId])
      expect(upd.rowCount).toBe(0)
    })
    // Tenant A's public widget (upload path) reserves on A's own counter.
    const viaWidget = await runWithTenantContext({ scope: "public", chatbotId: a.chatbotId }, () =>
      db().query<{ bytes_used: string }>("select bytes_used from attachment_storage_usage where owner_user_id = $1", [a.userId]),
    )
    expect(viaWidget.rows[0]?.bytes_used).toBe("4242")
  })

  it("workspace_members", async () => {
    const a = await seedOwnedChatbot("cs15-wm-a")
    const b = await seedOwnedChatbot("cs15-wm-b", "free")
    const { member } = await seedWorkspace(a)

    await asUser(b, async () => {
      const all = await db().query("select id from workspace_members where owner_user_id = $1", [a.userId])
      expect(all.rowCount).toBe(0)
      const upd = await db().query("update workspace_members set role = 'admin' where owner_user_id = $1", [a.userId])
      expect(upd.rowCount).toBe(0)
      // B cannot add itself to A's workspace without A's pending invite token.
      await expectDenied(
        db().query(
          `insert into workspace_members (owner_user_id, member_user_id, role, invited_by) values ($1, $2, 'admin', $1)`,
          [a.userId, b.userId],
        ),
      )
    })
    // The member sees its own row but cannot promote itself.
    await asUser(member, async () => {
      const own = await db().query("select role from workspace_members where member_user_id = $1", [member.userId])
      expect(own.rows[0]?.role).toBe("viewer")
      await expectDenied(db().query("update workspace_members set role = 'admin' where member_user_id = $1", [member.userId]))
    })
  })

  it("workspace_invitations", async () => {
    const a = await seedOwnedChatbot("cs15-wi-a")
    const b = await seedOwnedChatbot("cs15-wi-b", "free")
    const { rawToken, inviteId } = await seedWorkspace(a)

    await asUser(b, async () => {
      const all = await db().query("select id from workspace_invitations where owner_user_id = $1", [a.userId])
      expect(all.rowCount).toBe(0)
      const upd = await db().query("update workspace_invitations set status = 'revoked' where id = $1", [inviteId])
      expect(upd.rowCount).toBe(0)
    })
    // A wrong token reveals nothing; nor does the right token for a user the
    // invitation is not addressed to (the addressee case is covered under F2).
    const wrong = await asUser(b, () => db().query("select id from workspace_invitations"), { lookupHash: sha256("nope") })
    expect(wrong.rows.map((r) => r.id)).not.toContain(inviteId)
    const right = await asUser(b, () => db().query<{ id: string }>("select id from workspace_invitations"), {
      lookupHash: sha256(rawToken),
    })
    expect(right.rows.map((r) => r.id)).not.toContain(inviteId)
  })

  it("workspace_audit_log", async () => {
    const a = await seedOwnedChatbot("cs15-wal-a")
    const b = await seedOwnedChatbot("cs15-wal-b", "free")
    await seedWorkspace(a)

    await asUser(b, async () => {
      const all = await db().query("select id from workspace_audit_log where owner_user_id = $1", [a.userId])
      expect(all.rowCount).toBe(0)
      await expectDenied(
        db().query(`insert into workspace_audit_log (owner_user_id, actor_user_id, action) values ($1, $2, 'forged')`, [
          a.userId,
          b.userId,
        ]),
      )
      const del = await db().query("delete from workspace_audit_log where owner_user_id = $1", [a.userId])
      expect(del.rowCount).toBe(0)
    })
  })
})

// Review F2: a signed-in invitee holding one valid token must not be able to
// rewrite the invitation or join any workspace other than as invited.
describe("CS-15 review F2: an invitee's token grants only the status transition and its own membership", () => {
  async function seedInvite(owner: SeededTenant, invitee: SeededTenant, role: "viewer" | "admin" = "viewer") {
    const { rows } = await db().query<{ email: string }>("select email from users where id = $1", [invitee.userId])
    const rawToken = `cs15-f2-${randomUUID()}`
    const invite = await db().query<{ id: string }>(
      `insert into workspace_invitations (owner_user_id, email, role, token_hash, invited_by, expires_at)
       values ($1, $2, $3, $4, $1, now() + interval '1 day') returning id`,
      [owner.userId, rows[0].email, role, sha256(rawToken)],
    )
    return { inviteId: invite.rows[0].id, lookupHash: sha256(rawToken) }
  }

  async function inTx<T>(tenant: SeededTenant, lookupHash: string, fn: (q: (sql: string, params?: unknown[]) => Promise<{ rowCount: number | null }>) => Promise<T>) {
    return runWithTenantContext({ scope: "user", userId: tenant.userId, lookupHash }, async () => {
      const client = await db().connect()
      try {
        await client.query("begin")
        const result = await fn((sql, params) => client.query(sql, params as never[]))
        await client.query("rollback")
        return result
      } catch (err) {
        await client.query("rollback").catch(() => undefined)
        throw err
      } finally {
        client.release()
      }
    })
  }

  it("cannot re-point the invitation at another owner or raise its role", async () => {
    const owner = await seedOwnedChatbot("cs15-f2-owner")
    const victim = await seedOwnedChatbot("cs15-f2-victim")
    const invitee = await seedOwnedChatbot("cs15-f2-invitee", "free")
    const { inviteId, lookupHash } = await seedInvite(owner, invitee)

    for (const sql of [
      "update workspace_invitations set owner_user_id = $2, role = 'admin' where id = $1",
      "update workspace_invitations set owner_user_id = $2 where id = $1",
    ]) {
      await expectDenied(inTx(invitee, lookupHash, (q) => q(sql, [inviteId, victim.userId])))
    }
    await expectDenied(inTx(invitee, lookupHash, (q) => q("update workspace_invitations set role = 'admin' where id = $1", [inviteId])))
    // The sanctioned transition still works.
    const accepted = await inTx(invitee, lookupHash, (q) =>
      q("update workspace_invitations set status = 'accepted', accepted_at = now() where id = $1", [inviteId]),
    )
    expect(accepted.rowCount).toBe(1)
    const { rows } = await db().query<{ owner_user_id: string; role: string; status: string }>(
      "select owner_user_id, role, status from workspace_invitations where id = $1",
      [inviteId],
    )
    expect(rows[0]).toEqual({ owner_user_id: owner.userId, role: "viewer", status: "pending" })
  })

  it("cannot forge a new invitation into someone else's workspace", async () => {
    const victim = await seedOwnedChatbot("cs15-f2-forge-victim")
    const invitee = await seedOwnedChatbot("cs15-f2-forger", "free")
    const { rows } = await db().query<{ email: string }>("select email from users where id = $1", [invitee.userId])
    const lookupHash = sha256(`cs15-f2-forged-${randomUUID()}`)
    await expectDenied(
      inTx(invitee, lookupHash, (q) =>
        q(
          `insert into workspace_invitations (owner_user_id, email, role, token_hash, invited_by, expires_at)
           values ($1, $2, 'admin', $3, $1, now() + interval '1 day')`,
          [victim.userId, rows[0].email, lookupHash],
        ),
      ),
    )
  })

  it("membership insert needs an invitation accepted in the same transaction, for that workspace and role", async () => {
    const owner = await seedOwnedChatbot("cs15-f2-wm-owner")
    const victim = await seedOwnedChatbot("cs15-f2-wm-victim")
    const invitee = await seedOwnedChatbot("cs15-f2-wm-invitee", "free")
    const { inviteId, lookupHash } = await seedInvite(owner, invitee, "viewer")
    const insert = "insert into workspace_members (owner_user_id, member_user_id, role, invited_by) values ($1, $2, $3, $1)"

    // Pending (not accepted) invitation: denied.
    await expectDenied(inTx(invitee, lookupHash, (q) => q(insert, [owner.userId, invitee.userId, "viewer"])))
    // Accepted, but a different workspace or a higher role: denied.
    for (const [ownerId, role] of [
      [victim.userId, "viewer"],
      [owner.userId, "admin"],
    ]) {
      await expectDenied(
        inTx(invitee, lookupHash, async (q) => {
          await q("update workspace_invitations set status = 'accepted', accepted_at = now() where id = $1", [inviteId])
          return q(insert, [ownerId, invitee.userId, role])
        }),
      )
    }
    // A different user holding the token is not the addressee: denied.
    const stranger = await seedOwnedChatbot("cs15-f2-wm-stranger", "free")
    await expectDenied(
      inTx(stranger, lookupHash, async (q) => {
        const upd = await q("update workspace_invitations set status = 'accepted', accepted_at = now() where id = $1", [inviteId])
        expect(upd.rowCount).toBe(0)
        return q(insert, [owner.userId, stranger.userId, "viewer"])
      }),
    )
    // The real flow: accept, then insert, same transaction.
    const ok = await inTx(invitee, lookupHash, async (q) => {
      await q("update workspace_invitations set status = 'accepted', accepted_at = now() where id = $1", [inviteId])
      return q(insert, [owner.userId, invitee.userId, "viewer"])
    })
    expect(ok.rowCount).toBe(1)
  })
})

describe("CS-15 review F6: admin_users is not reachable on the tenant login", () => {
  it("chatmate360_app cannot read admin password hashes", async () => {
    const a = await seedOwnedChatbot("cs15-admin-users")
    await asUser(a, async () => {
      await expectDenied(db().query("select password_hash from admin_users limit 1"))
    })
  })
})

describe("CS-15 B09-017: a query with no tenant context fails closed", () => {
  it("bare pool.query outside any context sees 0 rows once the test-harness opt-in is off", async () => {
    const a = await seedOwnedChatbot("cs15-noctx")
    const attachmentId = await seedAttachment(a)

    tenantContext.allowImplicitSystemContextForTests(false)
    try {
      expect(tenantContext.resolveTenantGucs().scope).toBe("")
      const bots = await db().query("select id from chatbots where id = $1", [a.chatbotId])
      const atts = await db().query("select id from chatbot_attachments where id = $1", [attachmentId])
      const role = await db().query<{ current_user: string }>("select current_user")
      expect(bots.rowCount).toBe(0)
      expect(atts.rowCount).toBe(0)
      expect(role.rows[0].current_user).toBe("chatmate360_app")
    } finally {
      tenantContext.allowImplicitSystemContextForTests(true)
    }
  })
})
