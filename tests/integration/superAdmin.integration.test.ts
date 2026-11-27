import { randomUUID } from "node:crypto"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import pg from "pg"
import request from "supertest"
import { afterAll, describe, expect, it } from "vitest"

import { REPO_ROOT, seedSuperAdmin, SeedSuperAdminError } from "../../scripts/seedSuperAdmin.js"
import { hashPassword } from "../../src/lib/auth.js"
import { pool } from "../../src/lib/db.js"
import { ADMIN_ACCOUNT_CHANGE_PER_ADMIN_PER_15_MIN } from "../../src/middleware/rateLimitAdminAccount.js"
import { app, cookieValue, signupUser } from "../helpers.js"

// SA-01 super admin. One file on purpose: the "last super admin" checks look
// at the set of active super admins, so the tests that create super admins
// must not run in parallel with each other. Every admin created here has an
// `sa01-` email and is deactivated in afterAll; nothing else is touched.

const ADMIN_COOKIE = "chatmate360_admin_token"
const ORIGIN = "https://frontend.test"
const PASSWORD = "sa01 admin password long enough"

type Role = "super_admin" | "admin"
type TestAdmin = { id: string; email: string; password: string; cookie: string }

const createdAdminIds: string[] = []

function sa01Email(label: string): string {
  return `sa01-${label}-${randomUUID()}@example.test`
}

async function insertAdmin(label: string, role: Role, password = PASSWORD): Promise<{ id: string; email: string; password: string }> {
  const email = sa01Email(label)
  const { rows } = await pool!.query<{ id: string }>(
    "insert into admin_users (email, password_hash, name, role) values ($1, $2, $3, $4) returning id",
    [email, await hashPassword(password), `SA01 ${label}`, role],
  )
  createdAdminIds.push(rows[0].id)
  return { id: rows[0].id, email, password }
}

async function login(email: string, password: string): Promise<request.Response> {
  return request(app).post("/admin/login").send({ email, password })
}

async function signIn(email: string, password: string): Promise<string> {
  const res = await login(email, password)
  if (res.status !== 200) throw new Error(`admin login failed: ${res.status} ${JSON.stringify(res.body)}`)
  return cookieValue(res, ADMIN_COOKIE)
}

async function createAdmin(label: string, role: Role): Promise<TestAdmin> {
  const admin = await insertAdmin(label, role)
  return { ...admin, cookie: await signIn(admin.email, admin.password) }
}

function as(cookie: string) {
  return { Cookie: `${ADMIN_COOKIE}=${cookie}`, Origin: ORIGIN }
}

async function auditRows(adminUserId: string, action: string) {
  const { rows } = await pool!.query<{ target_user_id: string | null; detail: Record<string, unknown> }>(
    "select target_user_id, detail from admin_audit_log where admin_user_id = $1 and action = $2 order by created_at",
    [adminUserId, action],
  )
  return rows
}

afterAll(async () => {
  if (createdAdminIds.length) {
    await pool!.query("update admin_users set is_active = false where id = any($1::uuid[])", [createdAdminIds])
  }
})

describe("SA-01 role checks", () => {
  it("login and /admin/me expose the role read from the database", async () => {
    const sup = await insertAdmin("me-super", "super_admin")
    const res = await login(sup.email, sup.password)
    expect(res.status).toBe(200)
    expect(res.body.admin).toMatchObject({ id: sup.id, role: "super_admin" })
    expect(JSON.stringify(res.body)).not.toMatch(/token|password/i)

    const plain = await createAdmin("me-plain", "admin")
    const me = await request(app).get("/admin/me").set(as(plain.cookie))
    expect(me.status).toBe(200)
    expect(me.body.admin).toMatchObject({ id: plain.id, email: plain.email, role: "admin" })
  })

  it("a plain admin gets 403 on every super-admin endpoint and keeps the existing admin endpoints", async () => {
    const plain = await createAdmin("403-plain", "admin")
    const other = await insertAdmin("403-target", "admin")
    const { user } = await signupUser("sa01-403-customer")
    const calls: Array<[string, () => request.Test]> = [
      ["GET /admin/workspaces", () => request(app).get("/admin/workspaces").set(as(plain.cookie))],
      ["GET members", () => request(app).get(`/admin/users/${user.id}/members`).set(as(plain.cookie))],
      ["GET chatbots", () => request(app).get(`/admin/users/${user.id}/chatbots`).set(as(plain.cookie))],
      ["GET /admin/admins", () => request(app).get("/admin/admins").set(as(plain.cookie))],
      [
        "POST /admin/admins",
        () =>
          request(app)
            .post("/admin/admins")
            .set(as(plain.cookie))
            .send({ email: sa01Email("403-new"), name: "x", password: PASSWORD, role: "super_admin" }),
      ],
      ["PATCH /admin/admins/:id", () => request(app).patch(`/admin/admins/${other.id}`).set(as(plain.cookie)).send({ role: "super_admin" })],
      ["PATCH self to super_admin", () => request(app).patch(`/admin/admins/${plain.id}`).set(as(plain.cookie)).send({ role: "super_admin" })],
      ["POST revoke-sessions", () => request(app).post(`/admin/admins/${other.id}/revoke-sessions`).set(as(plain.cookie))],
      // SA-02: deleting accounts and changing plans or pricing are super-admin only.
      ["DELETE /admin/users/:id", () => request(app).delete(`/admin/users/${user.id}`).set(as(plain.cookie)).send({})],
      ["POST cancel-subscription", () => request(app).post(`/admin/users/${user.id}/cancel-subscription`).set(as(plain.cookie))],
      ["POST activate-plan", () => request(app).post(`/admin/users/${user.id}/activate-plan`).set(as(plain.cookie)).send({})],
      ["PATCH entitlement-override", () => request(app).patch(`/admin/users/${user.id}/entitlement-override`).set(as(plain.cookie)).send({})],
      ["POST /admin/pricing", () => request(app).post("/admin/pricing").set(as(plain.cookie)).send({})],
      ["POST /admin/pricing/recalculate", () => request(app).post("/admin/pricing/recalculate").set(as(plain.cookie))],
    ]
    for (const [name, call] of calls) {
      const res = await call()
      expect(res.status, name).toBe(403)
      expect(res.body, name).toEqual({ ok: false, error: "Super admin access required." })
    }
    // Nothing changed.
    const { rows } = await pool!.query("select role from admin_users where id = any($1::uuid[]) order by role", [[plain.id, other.id]])
    expect(rows.map((r) => r.role)).toEqual(["admin", "admin"])

    // Regular admin capabilities are unchanged.
    expect((await request(app).get("/admin/users").set(as(plain.cookie))).status).toBe(200)
    expect((await request(app).get(`/admin/users/${user.id}`).set(as(plain.cookie))).status).toBe(200)
  })

  it("a demotion applies to the very next request of an existing super admin session", async () => {
    const actor = await createAdmin("demote-actor", "super_admin")
    const target = await createAdmin("demote-target", "super_admin")
    expect((await request(app).get("/admin/admins").set(as(target.cookie))).status).toBe(200)
    const demote = await request(app).patch(`/admin/admins/${target.id}`).set(as(actor.cookie)).send({ role: "admin" })
    expect(demote.status).toBe(200)
    expect(demote.body.admin.role).toBe("admin")
    expect((await request(app).get("/admin/admins").set(as(target.cookie))).status).toBe(403)
    expect((await request(app).get("/admin/me").set(as(target.cookie))).body.admin.role).toBe("admin")
    const audit = await auditRows(actor.id, "update_admin")
    expect(audit.at(-1)?.detail).toMatchObject({ targetAdminId: target.id, role: { from: "super_admin", to: "admin" } })
  })
})

describe("SA-01 customer account views", () => {
  it("shows a customer's members, pending and expired invitations, and never token values", async () => {
    const sup = await createAdmin("members-super", "super_admin")
    const owner = await signupUser("sa01-owner")
    const member = await signupUser("sa01-member")
    await pool!.query(
      "insert into workspace_members (owner_user_id, member_user_id, role, invited_by) values ($1, $2, 'viewer', $1)",
      [owner.user.id, member.user.id],
    )
    const secret = (label: string) => `sa01tokenhash${label}${randomUUID().replaceAll("-", "")}`
    const tokens = { pending: secret("pending"), lapsed: secret("lapsed"), revoked: secret("revoked") }
    await pool!.query(
      `insert into workspace_invitations (owner_user_id, email, role, token_hash, status, invited_by, expires_at, revoked_at) values
         ($1, $2, 'admin',  $3, 'pending', $1, now() + interval '3 days', null),
         ($1, $4, 'viewer', $5, 'pending', $1, now() - interval '1 day', null),
         ($1, $6, 'viewer', $7, 'revoked', $1, now() + interval '3 days', now())`,
      [owner.user.id, "pending@example.test", tokens.pending, "lapsed@example.test", tokens.lapsed, "revoked@example.test", tokens.revoked],
    )

    const res = await request(app).get(`/admin/users/${owner.user.id}/members`).set(as(sup.cookie))
    expect(res.status).toBe(200)
    expect(res.body.owner).toEqual({ id: owner.user.id, email: owner.email })
    expect(res.body.memberCount).toBe(1)
    expect(res.body.members).toEqual([
      expect.objectContaining({ userId: member.user.id, email: member.email, role: "viewer", joinedAt: expect.any(String) }),
    ])
    expect(res.body.invitationCount).toBe(2)
    const byEmail = Object.fromEntries((res.body.invitations as Array<{ email: string; status: string; role: string }>).map((i) => [i.email, i]))
    expect(Object.keys(byEmail).sort()).toEqual(["lapsed@example.test", "pending@example.test"])
    expect(byEmail["pending@example.test"]).toMatchObject({ status: "pending", role: "admin" })
    expect(byEmail["lapsed@example.test"]).toMatchObject({ status: "expired", role: "viewer" })

    const raw = JSON.stringify(res.body)
    for (const value of Object.values(tokens)) expect(raw).not.toContain(value)
    expect(raw).not.toMatch(/token/i)

    const audit = await auditRows(sup.id, "view_account_members")
    expect(audit.some((r) => r.target_user_id === owner.user.id)).toBe(true)

    // Workspaces list: searchable, with member and pending-invite counts.
    const ws = await request(app).get("/admin/workspaces").query({ search: owner.email }).set(as(sup.cookie))
    expect(ws.status).toBe(200)
    expect(ws.body.totalCount).toBe(1)
    expect(ws.body.workspaces[0]).toMatchObject({ ownerUserId: owner.user.id, memberCount: 1, pendingInvitationCount: 1 })
    const memberRow = await request(app).get("/admin/workspaces").query({ search: member.email }).set(as(sup.cookie))
    expect(memberRow.body.workspaces[0]).toMatchObject({ ownerUserId: member.user.id, memberOfOwnerUserId: owner.user.id })
    expect((await auditRows(sup.id, "list_workspaces")).length).toBeGreaterThanOrEqual(2)

    // The customer accounts list (all admins) now carries the member count.
    const plain = await createAdmin("members-plain", "admin")
    const users = await request(app).get("/admin/users").query({ search: owner.email }).set(as(plain.cookie))
    expect(users.status).toBe(200)
    expect(users.body.users[0]).toMatchObject({ id: owner.user.id, memberCount: 1 })
  })

  it("lists a customer's chatbots with document counts, read-only, and bounds pagination", async () => {
    const sup = await createAdmin("chatbots-super", "super_admin")
    const owner = await signupUser("sa01-bot-owner")
    const created = await request(app)
      .post("/chatbots")
      .set("Authorization", `Bearer ${owner.session.access_token}`)
      .send({ name: "SA01 bot 1", sources: [{ type: "pdf", label: "a.pdf", characters: 20, content: "Hello from SA01." }] })
    expect(created.status).toBe(201)
    // The trial plan allows one chatbot through the API; the second is a fixture row.
    const { rows: second } = await pool!.query<{ id: string }>(
      "insert into chatbots (user_id, name, is_active) values ($1, 'SA01 bot 2', false) returning id",
      [owner.user.id],
    )
    const ids = [created.body.chatbot.id as string, second[0].id]
    await pool!.query(
      "insert into chatbot_documents (chatbot_id, file_name, file_type, file_size, status) values ($1, 'x.pdf', 'pdf', 10, 'ready'), ($1, 'y.pdf', 'pdf', 10, 'ready')",
      [ids[0]],
    )
    const { rows: expected } = await pool!.query<{ id: string; n: number }>(
      "select chatbot_id as id, count(*)::int as n from chatbot_documents where chatbot_id = any($1::uuid[]) group by chatbot_id",
      [ids],
    )
    const expectedCount = (id: string) => expected.find((r) => r.id === id)?.n ?? 0

    const res = await request(app).get(`/admin/users/${owner.user.id}/chatbots`).set(as(sup.cookie))
    expect(res.status).toBe(200)
    expect(res.body.totalCount).toBe(2)
    for (const id of ids) {
      const bot = res.body.chatbots.find((c: { id: string }) => c.id === id)
      expect(bot).toMatchObject({ id, name: expect.stringMatching(/^SA01 bot/), status: expect.any(String), createdAt: expect.any(String) })
      expect(bot.documentCount).toBe(expectedCount(id))
    }
    expect(expectedCount(ids[0])).toBeGreaterThanOrEqual(2)

    const paged = await request(app).get(`/admin/users/${owner.user.id}/chatbots`).query({ limit: 1 }).set(as(sup.cookie))
    expect(paged.body.chatbots).toHaveLength(1)
    expect(paged.body.totalCount).toBe(2)
    const huge = await request(app).get("/admin/workspaces").query({ limit: 100000 }).set(as(sup.cookie))
    expect(huge.status).toBe(200)
    expect(huge.body.workspaces.length).toBeLessThanOrEqual(100)

    expect((await auditRows(sup.id, "view_account_chatbots")).some((r) => r.target_user_id === owner.user.id)).toBe(true)
    expect((await request(app).get(`/admin/users/${randomUUID()}/chatbots`).set(as(sup.cookie))).status).toBe(404)
  })
})

describe("SA-01 admin management", () => {
  it("creates admins with the password policy and case-insensitive unique emails", async () => {
    const sup = await createAdmin("create-super", "super_admin")
    const email = sa01Email("created")
    const weak = await request(app).post("/admin/admins").set(as(sup.cookie)).send({ email, name: "New", password: "elevenchars", role: "admin" })
    expect(weak.status).toBe(400)

    const created = await request(app)
      .post("/admin/admins")
      .set(as(sup.cookie))
      .send({ email: email.toUpperCase(), name: "New Admin", password: PASSWORD, role: "admin" })
    expect(created.status).toBe(201)
    expect(created.body.admin).toMatchObject({ email, role: "admin", isActive: true })
    expect(JSON.stringify(created.body)).not.toMatch(/password/i)
    createdAdminIds.push(created.body.admin.id)

    const dup = await request(app).post("/admin/admins").set(as(sup.cookie)).send({ email, name: "Dup", password: PASSWORD, role: "admin" })
    expect(dup.status).toBe(409)

    const newLogin = await login(email, PASSWORD)
    expect(newLogin.status).toBe(200)
    expect(newLogin.body.admin.role).toBe("admin")

    const audit = await auditRows(sup.id, "create_admin")
    expect(audit.at(-1)?.detail).toEqual({ targetAdminId: created.body.admin.id, role: "admin" })

    const list = await request(app).get("/admin/admins").query({ limit: 100 }).set(as(sup.cookie))
    expect(list.status).toBe(200)
    expect(JSON.stringify(list.body)).not.toMatch(/password|hash/i)
  })

  it("refuses to change your own role or deactivate yourself", async () => {
    const sup = await createAdmin("self-super", "super_admin")
    expect((await request(app).patch(`/admin/admins/${sup.id}`).set(as(sup.cookie)).send({ role: "admin" })).status).toBe(400)
    expect((await request(app).patch(`/admin/admins/${sup.id}`).set(as(sup.cookie)).send({ isActive: false })).status).toBe(400)
    expect((await request(app).post(`/admin/admins/${sup.id}/revoke-sessions`).set(as(sup.cookie))).status).toBe(400)
    const rename = await request(app).patch(`/admin/admins/${sup.id}`).set(as(sup.cookie)).send({ name: "Renamed" })
    expect(rename.status).toBe(200)
    const { rows } = await pool!.query("select role, is_active from admin_users where id = $1", [sup.id])
    expect(rows[0]).toEqual({ role: "super_admin", is_active: true })
  })

  it("cannot remove or demote the last active super admin, even with two concurrent cross-demotions", async () => {
    // Leftover super admins from earlier runs of this file would make "last"
    // meaningless; only rows this file creates (sa01-*) are touched.
    await pool!.query("update admin_users set is_active = false where role = 'super_admin' and email like 'sa01-%@example.test'")
    const a = await createAdmin("last-a", "super_admin")
    const b = await createAdmin("last-b", "super_admin")
    const { rows: before } = await pool!.query<{ n: number }>("select count(*)::int as n from admin_users where role = 'super_admin' and is_active")
    expect(before[0].n).toBeGreaterThanOrEqual(2)

    // A and B try to remove each other at the same moment. Without the lock
    // both see "another super admin remains" and both succeed.
    const [r1, r2] = await Promise.all([
      request(app).patch(`/admin/admins/${b.id}`).set(as(a.cookie)).send({ role: "admin" }),
      request(app).patch(`/admin/admins/${a.id}`).set(as(b.cookie)).send({ isActive: false }),
    ])
    const statuses = [r1.status, r2.status].sort()
    expect(statuses[0]).toBe(200)
    expect([403, 409]).toContain(statuses[1])

    const { rows: after } = await pool!.query<{ id: string }>(
      "select id from admin_users where id = any($1::uuid[]) and role = 'super_admin' and is_active",
      [[a.id, b.id]],
    )
    expect(after).toHaveLength(1)

    // The survivor is now the last active sa01 super admin; nobody else can
    // act as super admin to remove it, and it cannot remove itself.
    const survivor = after[0].id === a.id ? a : b
    expect((await request(app).patch(`/admin/admins/${survivor.id}`).set(as(survivor.cookie)).send({ isActive: false })).status).toBe(400)
    const loser = survivor === a ? b : a
    const loserTry = await request(app).patch(`/admin/admins/${survivor.id}`).set(as(loser.cookie)).send({ role: "admin" })
    expect([401, 403]).toContain(loserTry.status)
  })

  it("a deactivated admin cannot sign in and its existing cookie stops working", async () => {
    const sup = await createAdmin("deact-super", "super_admin")
    const target = await createAdmin("deact-target", "admin")
    const secondCookie = await signIn(target.email, target.password)
    expect((await request(app).get("/admin/me").set(as(target.cookie))).status).toBe(200)

    const off = await request(app).patch(`/admin/admins/${target.id}`).set(as(sup.cookie)).send({ isActive: false })
    expect(off.status).toBe(200)
    expect(off.body.admin.isActive).toBe(false)

    expect((await request(app).get("/admin/me").set(as(target.cookie))).status).toBe(401)
    expect((await request(app).get("/admin/users").set(as(secondCookie))).status).toBe(401)
    const denied = await login(target.email, target.password)
    expect(denied.status).toBe(401)
    expect(denied.body.error).toBe("Invalid email or password.")

    // Reactivation does not resurrect the old cookies.
    expect((await request(app).patch(`/admin/admins/${target.id}`).set(as(sup.cookie)).send({ isActive: true })).status).toBe(200)
    expect((await request(app).get("/admin/me").set(as(target.cookie))).status).toBe(401)
    expect((await login(target.email, target.password)).status).toBe(200)
  })

  it("revoke-sessions ends every session of the target admin", async () => {
    const sup = await createAdmin("revoke-super", "super_admin")
    const target = await createAdmin("revoke-target", "admin")
    expect((await request(app).post(`/admin/admins/${target.id}/revoke-sessions`).set(as(sup.cookie))).status).toBe(200)
    expect((await request(app).get("/admin/me").set(as(target.cookie))).status).toBe(401)
    expect((await request(app).get("/admin/me").set(as(sup.cookie))).status).toBe(200)
    expect((await auditRows(sup.id, "revoke_admin_sessions")).at(-1)?.detail).toEqual({ targetAdminId: target.id })
  })
})

describe("SA-01 own credentials (PATCH /admin/account)", () => {
  it("needs the current password, enforces the policy and email uniqueness", async () => {
    const me = await createAdmin("acct-checks", "admin")
    const other = await insertAdmin("acct-other", "admin")
    const patch = (body: object) => request(app).patch("/admin/account").set(as(me.cookie)).send(body)

    expect((await patch({ newPassword: "a brand new long password" })).status).toBe(400)
    expect((await patch({ currentPassword: "wrong password here", newPassword: "a brand new long password" })).status).toBe(401)
    expect((await patch({ currentPassword: me.password, newPassword: "short pass" })).status).toBe(400)
    expect((await patch({ currentPassword: me.password, newEmail: other.email.toUpperCase() })).status).toBe(409)
    // Nothing changed: the old password still signs in.
    expect((await login(me.email, me.password)).status).toBe(200)
    expect((await request(app).get("/admin/me").set(as(me.cookie))).status).toBe(200)
    expect((await auditRows(me.id, "update_admin_account_failed")).length).toBe(1)
  })

  it("success revokes every other session and re-issues the current cookie", async () => {
    const me = await createAdmin("acct-ok", "admin")
    const otherDevice = await signIn(me.email, me.password)
    const newPassword = "a completely new admin passphrase"
    const newEmail = sa01Email("acct-renamed")

    const res = await request(app)
      .patch("/admin/account")
      .set(as(me.cookie))
      .send({ currentPassword: me.password, newPassword, newEmail: `  ${newEmail.toUpperCase()} ` })
    expect(res.status).toBe(200)
    expect(res.body.admin).toMatchObject({ id: me.id, email: newEmail, role: "admin" })
    const reissued = cookieValue(res, ADMIN_COOKIE)

    expect((await request(app).get("/admin/me").set(as(otherDevice))).status).toBe(401)
    expect((await request(app).get("/admin/me").set(as(me.cookie))).status).toBe(401)
    expect((await request(app).get("/admin/me").set(as(reissued))).status).toBe(200)

    expect((await login(me.email, me.password)).status).toBe(401)
    expect((await login(newEmail, me.password)).status).toBe(401)
    expect((await login(newEmail, newPassword)).status).toBe(200)

    const audit = await auditRows(me.id, "update_admin_account")
    expect(audit.at(-1)?.detail).toEqual({ changedEmail: true, changedPassword: true, otherSessionsRevoked: true })
    expect(JSON.stringify(audit)).not.toContain(newPassword)
  })

  it("is rate limited per admin account", async () => {
    const me = await createAdmin("acct-rate", "admin")
    const statuses: number[] = []
    for (let i = 0; i <= ADMIN_ACCOUNT_CHANGE_PER_ADMIN_PER_15_MIN; i += 1) {
      const res = await request(app).patch("/admin/account").set(as(me.cookie)).send({ currentPassword: "wrong guess number x", newPassword: PASSWORD })
      statuses.push(res.status)
    }
    expect(statuses.slice(0, ADMIN_ACCOUNT_CHANGE_PER_ADMIN_PER_15_MIN).every((s) => s === 401)).toBe(true)
    expect(statuses.at(-1)).toBe(429)
  })
})

describe("SA-01 seed script", () => {
  const tmpDirs: string[] = []
  afterAll(async () => {
    for (const dir of tmpDirs) await rm(dir, { recursive: true, force: true })
  })
  async function tmpDir(): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sa01-seed-"))
    tmpDirs.push(dir)
    return dir
  }
  async function adminByEmail(email: string) {
    const { rows } = await pool!.query<{ id: string; role: string; is_active: boolean; password_hash: string }>(
      "select id, role, is_active, password_hash from admin_users where email = $1",
      [email],
    )
    if (rows[0]) createdAdminIds.push(rows[0].id)
    return rows[0]
  }

  it("refuses short passwords, a missing credentials file, relative paths and paths inside the repo", async () => {
    const email = sa01Email("seed-refuse")
    await expect(seedSuperAdmin(pool!, { email, password: "elevenchars", credentialsFile: undefined, resetPassword: false })).rejects.toThrow(
      SeedSuperAdminError,
    )
    await expect(seedSuperAdmin(pool!, { email, password: undefined, credentialsFile: undefined, resetPassword: false })).rejects.toThrow(
      /SUPER_ADMIN_CREDENTIALS_FILE is required/,
    )
    await expect(
      seedSuperAdmin(pool!, { email, password: undefined, credentialsFile: "creds.txt", resetPassword: false }),
    ).rejects.toThrow(/absolute path/)
    const inside = path.join(REPO_ROOT, "var", `sa01-creds-${randomUUID()}.txt`)
    await expect(seedSuperAdmin(pool!, { email, password: undefined, credentialsFile: inside, resetPassword: false })).rejects.toThrow(
      /inside the repository/,
    )
    const sneaky = path.join(REPO_ROOT, "..", path.basename(REPO_ROOT), `sa01-${randomUUID()}.txt`)
    await expect(seedSuperAdmin(pool!, { email, password: undefined, credentialsFile: sneaky, resetPassword: false })).rejects.toThrow(
      /inside the repository/,
    )
    await expect(readFile(inside)).rejects.toMatchObject({ code: "ENOENT" })
    expect(await adminByEmail(email)).toBeUndefined()
  })

  it("generates a password into the credentials file only, and is idempotent", async () => {
    const email = sa01Email("seed-gen")
    const file = path.join(await tmpDir(), "super-admin.txt")
    const first = await seedSuperAdmin(pool!, { email, password: undefined, credentialsFile: file, resetPassword: false })
    expect(first).toMatchObject({ email, action: "created", passwordSet: true })
    expect(JSON.stringify(first)).not.toMatch(/SUPER_ADMIN_PASSWORD/)

    const contents = await readFile(file, "utf8")
    const generated = /SUPER_ADMIN_PASSWORD=(.+)\n/.exec(contents)?.[1] ?? ""
    expect(contents).toContain(`SUPER_ADMIN_EMAIL=${email}`)
    expect(generated.length).toBeGreaterThanOrEqual(32)
    const row = await adminByEmail(email)
    expect(row).toMatchObject({ role: "super_admin", is_active: true })
    const signIn1 = await login(email, generated)
    expect(signIn1.status).toBe(200)
    expect(signIn1.body.admin.role).toBe("super_admin")

    // Re-run without a password: nothing changes and no file is needed.
    const again = await seedSuperAdmin(pool!, { email, password: undefined, credentialsFile: undefined, resetPassword: false })
    expect(again).toMatchObject({ adminUserId: first.adminUserId, action: "unchanged", passwordSet: false, credentialsFileWritten: null })
    expect((await adminByEmail(email))?.password_hash).toBe(row!.password_hash)

    // An existing credentials file is never overwritten, and the DB is untouched.
    await expect(seedSuperAdmin(pool!, { email, password: undefined, credentialsFile: file, resetPassword: true })).rejects.toMatchObject({
      code: "EEXIST",
    })
    expect((await adminByEmail(email))?.password_hash).toBe(row!.password_hash)
    expect((await login(email, generated)).status).toBe(200)
  })

  it("promotes an existing admin without touching its password unless --reset-password", async () => {
    const existing = await createAdmin("seed-promote", "admin")
    const given = "a seeded super admin password"
    const promoted = await seedSuperAdmin(pool!, { email: existing.email, password: given, credentialsFile: undefined, resetPassword: false })
    expect(promoted).toMatchObject({ adminUserId: existing.id, action: "promoted", passwordSet: false })
    expect((await adminByEmail(existing.email))?.role).toBe("super_admin")
    expect((await login(existing.email, existing.password)).status).toBe(200)
    expect((await login(existing.email, given)).status).toBe(401)
    expect((await request(app).get("/admin/me").set(as(existing.cookie))).body.admin.role).toBe("super_admin")

    const reset = await seedSuperAdmin(pool!, { email: existing.email, password: given, credentialsFile: undefined, resetPassword: true })
    expect(reset).toMatchObject({ action: "promoted", passwordSet: true })
    expect((await login(existing.email, existing.password)).status).toBe(401)
    expect((await login(existing.email, given)).status).toBe(200)
    // A password reset ends the sessions opened with the old one.
    expect((await request(app).get("/admin/me").set(as(existing.cookie))).status).toBe(401)
  })
})

describe("SA-01 CS-15 boundary", () => {
  it("the app role still cannot read admin_users (password_hash or the new columns)", async () => {
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL })
    await client.connect()
    try {
      const { rows } = await client.query<{ r: string }>("select current_user as r")
      expect(rows[0].r).toBe("chatmate360_app")
      await expect(client.query("select password_hash from admin_users limit 1")).rejects.toMatchObject({ code: "42501" })
      await expect(client.query("select role, is_active from admin_users limit 1")).rejects.toMatchObject({ code: "42501" })
      await expect(client.query("update admin_users set role = 'super_admin'")).rejects.toMatchObject({ code: "42501" })
    } finally {
      await client.end()
    }
  })
})
