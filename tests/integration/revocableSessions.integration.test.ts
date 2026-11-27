import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"

import bcrypt from "bcryptjs"
import request from "supertest"
import { afterAll, describe, expect, it, vi } from "vitest"

// CS-11 regression tests: server-side session revocation, verified-email
// invites, and cookie-based admin auth. Google config is dummy; Google is
// never contacted (fetch is mocked below, same pattern as googleOAuth tests).
vi.hoisted(() => {
  process.env.GOOGLE_CLIENT_ID = "cs11-test-client-id"
  process.env.GOOGLE_CLIENT_SECRET = "cs11-test-client-secret"
  process.env.GOOGLE_REDIRECT_URI = "https://api.test/auth/google/callback"
})

import { GOOGLE_OAUTH_STATE_COOKIE, hashPassword, hashRefreshToken, signAccessToken } from "../../src/lib/auth.js"
import { pool } from "../../src/lib/db.js"
import { runWithSystemContext } from "../../src/lib/tenantContext.js"
import { generateOpaqueToken, hashToken } from "../../src/services/notification.service.js"
import { app, cookieValue, signupUser, uniqueEmail } from "../helpers.js"

const TRUSTED_ORIGIN = "https://frontend.test" // FRONTEND_URL in vitest.config.ts
const ADMIN_COOKIE = "chatmate360_admin_token" // non-production name (no __Host- prefix over plain HTTP)

type Profile = { sub: string; email: string; email_verified: boolean }
const profilesByCode = new Map<string, Profile>()
const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
  if (url === "https://oauth2.googleapis.com/token") {
    const code = new URLSearchParams(String(init?.body)).get("code") ?? ""
    if (!profilesByCode.has(code)) return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })
    return new Response(JSON.stringify({ access_token: `at-${code}` }), { status: 200 })
  }
  if (url === "https://www.googleapis.com/oauth2/v3/userinfo") {
    const auth = new Headers(init?.headers).get("authorization") ?? ""
    const profile = profilesByCode.get(auth.replace(/^Bearer at-/, ""))
    return profile ? new Response(JSON.stringify(profile), { status: 200 }) : new Response("{}", { status: 401 })
  }
  throw new Error(`unexpected network call in test: ${url}`)
})
afterAll(() => fetchMock.mockRestore())

function bearer(token: string) {
  return { Authorization: `Bearer ${token}` }
}

function setCookies(res: request.Response): string[] {
  const raw = res.headers["set-cookie"]
  return Array.isArray(raw) ? raw : raw ? [raw] : []
}

async function createAdmin(label: string) {
  const email = uniqueEmail(label)
  const password = "a very strong admin password"
  const { rows } = await pool!.query<{ id: string }>(
    "insert into admin_users (email, password_hash, name) values ($1, $2, $3) returning id",
    [email, await hashPassword(password), "CS-11 Admin"],
  )
  const login = await request(app).post("/admin/login").send({ email, password })
  expect(login.status).toBe(200)
  return { id: rows[0].id, login, cookie: `${ADMIN_COOKIE}=${cookieValue(login, ADMIN_COOKIE)}` }
}

describe("CS-11 dashboard sessions are revocable server-side", () => {
  it("a deactivated user's existing access token is rejected immediately", async () => {
    const admin = await createAdmin("cs11-deact-admin")
    const user = await signupUser("cs11-deact-user")
    expect((await request(app).get("/auth/me").set(bearer(user.session.access_token))).status).toBe(200)

    const deactivate = await request(app)
      .post(`/admin/users/${user.user.id}/deactivate`)
      .set("Cookie", admin.cookie)
      .set("Origin", TRUSTED_ORIGIN)
    expect(deactivate.status).toBe(200)

    expect((await request(app).get("/auth/me").set(bearer(user.session.access_token))).status).toBe(401)
    expect((await request(app).get("/chatbots").set(bearer(user.session.access_token))).status).toBe(401)
    expect((await request(app).post("/auth/refresh").send({ refresh_token: user.session.refresh_token })).status).toBe(401)

    // Reactivation does not resurrect the old session.
    await request(app).post(`/admin/users/${user.user.id}/activate`).set("Cookie", admin.cookie).set("Origin", TRUSTED_ORIGIN)
    expect((await request(app).get("/auth/me").set(bearer(user.session.access_token))).status).toBe(401)
  })

  it("an access token issued before a password reset is rejected; a new sign-in works", async () => {
    const user = await signupUser("cs11-reset")
    const resetToken = generateOpaqueToken()
    await pool!.query(
      "insert into password_reset_tokens (user_id, token_hash, expires_at) values ($1, $2, now() + interval '30 minutes')",
      [user.user.id, hashToken(resetToken)],
    )
    const newPassword = "a brand new password 456"
    const reset = await request(app).post("/auth/password/reset").send({ token: resetToken, password: newPassword })
    expect(reset.status).toBe(200)

    expect((await request(app).get("/auth/me").set(bearer(user.session.access_token))).status).toBe(401)

    const login = await request(app).post("/auth/login").send({ email: user.email, password: newPassword })
    expect(login.status).toBe(200)
    const fresh = cookieValue(login, "chatmate360_access_token")
    expect((await request(app).get("/auth/me").set(bearer(fresh))).status).toBe(200)
  })

  it("Test F: after logout, replaying the old access or refresh cookie gets 401", async () => {
    const user = await signupUser("cs11-logout")
    const cookies = `chatmate360_access_token=${user.session.access_token}; chatmate360_refresh_token=${user.session.refresh_token}`
    expect((await request(app).get("/auth/me").set("Cookie", cookies)).status).toBe(200)

    const logout = await request(app).post("/auth/logout").set("Cookie", cookies).set("Origin", TRUSTED_ORIGIN).send({})
    expect(logout.status).toBe(200)

    expect((await request(app).get("/auth/me").set("Cookie", `chatmate360_access_token=${user.session.access_token}`)).status).toBe(401)
    const refresh = await request(app)
      .post("/auth/refresh")
      .set("Cookie", `chatmate360_refresh_token=${user.session.refresh_token}`)
      .set("Origin", TRUSTED_ORIGIN)
      .send({})
    expect(refresh.status).toBe(401)
  })

  it("logout only ends that session; refresh rotation keeps the session's access tokens valid", async () => {
    const user = await signupUser("cs11-two-sessions")
    const second = await request(app).post("/auth/login").send({ email: user.email, password: user.password })
    const secondAccess = cookieValue(second, "chatmate360_access_token")
    const secondRefresh = cookieValue(second, "chatmate360_refresh_token")

    const rotated = await request(app).post("/auth/refresh").send({ refresh_token: secondRefresh })
    expect(rotated.status).toBe(200)
    expect((await request(app).get("/auth/me").set(bearer(secondAccess))).status).toBe(200)
    expect((await request(app).get("/auth/me").set(bearer(cookieValue(rotated, "chatmate360_access_token")))).status).toBe(200)

    await request(app).post("/auth/logout").send({ refresh_token: user.session.refresh_token })
    expect((await request(app).get("/auth/me").set(bearer(user.session.access_token))).status).toBe(401)
    expect((await request(app).get("/auth/me").set(bearer(secondAccess))).status).toBe(200)
  })

  it("logout-all ends every session", async () => {
    const user = await signupUser("cs11-logout-all")
    const second = await request(app).post("/auth/login").send({ email: user.email, password: user.password })
    const secondAccess = cookieValue(second, "chatmate360_access_token")

    expect((await request(app).post("/auth/logout-all").set(bearer(user.session.access_token))).status).toBe(200)
    expect((await request(app).get("/auth/me").set(bearer(user.session.access_token))).status).toBe(401)
    expect((await request(app).get("/auth/me").set(bearer(secondAccess))).status).toBe(401)
    expect((await request(app).post("/auth/refresh").send({ refresh_token: cookieValue(second, "chatmate360_refresh_token") })).status).toBe(401)
  })

  it("Google link of an unverified account revokes its access tokens and removes memberships it created", async () => {
    const victimEmail = uniqueEmail("cs11-takeover")
    const signup = await request(app)
      .post("/auth/signup")
      .send({ name: "Pre-registrant", email: victimEmail, password: "attacker chosen password 123" })
    expect(signup.status).toBe(201)
    const attackerAccess = cookieValue(signup, "chatmate360_access_token")
    const victimId = signup.body.user.id as string

    // Workspace access the pre-registrant set up (e.g. before invites required
    // a verified email): a second account of theirs as a member, plus a pending invite.
    const accomplice = await signupUser("cs11-accomplice")
    await pool!.query(
      "insert into workspace_members (owner_user_id, member_user_id, role, invited_by) values ($1, $2, 'admin', $1)",
      [victimId, accomplice.user.id],
    )
    await pool!.query(
      `insert into workspace_invitations (owner_user_id, email, role, token_hash, invited_by, expires_at)
       values ($1, $2, 'viewer', $3, $1, now() + interval '7 days')`,
      [victimId, uniqueEmail("cs11-pending"), hashToken(generateOpaqueToken())],
    )

    const start = await request(app).get("/auth/google/start")
    const state = new URL(start.headers.location).searchParams.get("state") ?? ""
    const nonce = cookieValue(start, GOOGLE_OAUTH_STATE_COOKIE)
    const code = `code-${randomUUID()}`
    profilesByCode.set(code, { sub: `cs11-${randomUUID()}`, email: victimEmail, email_verified: true })
    const cb = await request(app)
      .get(`/auth/google/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`)
      .set("Cookie", `${GOOGLE_OAUTH_STATE_COOKIE}=${nonce}`)
    expect(cb.status).toBe(302)
    const ownerAccess = cookieValue(cb, "chatmate360_access_token")

    expect((await request(app).get("/auth/me").set(bearer(attackerAccess))).status).toBe(401)
    expect((await request(app).get("/auth/me").set(bearer(ownerAccess))).status).toBe(200)

    const { rows: members } = await pool!.query("select 1 from workspace_members where owner_user_id = $1", [victimId])
    expect(members).toHaveLength(0)
    const { rows: pending } = await pool!.query(
      "select 1 from workspace_invitations where owner_user_id = $1 and status = 'pending'",
      [victimId],
    )
    expect(pending).toHaveLength(0)
  })
})

describe("CS-11 invites need verified emails", () => {
  it("an unverified owner cannot invite", async () => {
    const signup = await request(app)
      .post("/auth/signup")
      .send({ name: "Unverified Owner", email: uniqueEmail("cs11-unverified-owner"), password: "correct horse battery staple" })
    expect(signup.status).toBe(201)
    const res = await request(app)
      .post("/account/members/invite")
      .set(bearer(cookieValue(signup, "chatmate360_access_token")))
      .send({ email: uniqueEmail("cs11-invitee"), role: "viewer" })
    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/verify your email/i)
  })

  it("an unverified account cannot accept an invite sent to its address", async () => {
    const owner = await signupUser("cs11-verified-owner")
    const inviteeEmail = uniqueEmail("cs11-unverified-invitee")
    const inviteToken = generateOpaqueToken()
    await pool!.query(
      `insert into workspace_invitations (owner_user_id, email, role, token_hash, invited_by, expires_at)
       values ($1, $2, 'viewer', $3, $1, now() + interval '7 days')`,
      [owner.user.id, inviteeEmail, hashToken(inviteToken)],
    )
    const signup = await request(app)
      .post("/auth/signup")
      .send({ name: "Unverified Invitee", email: inviteeEmail, password: "correct horse battery staple" })
    expect(signup.status).toBe(201)

    const res = await request(app)
      .post("/account/members/accept")
      .set(bearer(cookieValue(signup, "chatmate360_access_token")))
      .send({ token: inviteToken })
    expect(res.status).toBe(403)
    const { rows } = await pool!.query("select 1 from workspace_members where member_user_id = $1", [signup.body.user.id])
    expect(rows).toHaveLength(0)
  })
})

describe("CS-11 admin auth uses an httpOnly cookie", () => {
  it("login sets an httpOnly cookie and returns no token in the body", async () => {
    const { login } = await createAdmin("cs11-admin-login")
    expect(login.body.accessToken).toBeUndefined()
    expect(JSON.stringify(login.body)).not.toMatch(/eyJ/) // no JWT anywhere in the body
    const cookie = setCookies(login).find((c) => c.startsWith(`${ADMIN_COOKIE}=`)) ?? ""
    expect(cookie).toMatch(/HttpOnly/i)
    expect(cookie).toMatch(/Path=\//)
    expect(cookie).toMatch(/SameSite=Lax/i) // dev/test; production is SameSite=None; Secure with the __Host- prefix
  })

  it("admin endpoints work with the cookie; cross-origin state changes are refused", async () => {
    const admin = await createAdmin("cs11-admin-cookie")
    const target = await signupUser("cs11-admin-target")

    expect((await request(app).get("/admin/me").set("Cookie", admin.cookie)).status).toBe(200)
    expect((await request(app).get("/admin/users").set("Cookie", admin.cookie)).status).toBe(200)

    const evil = await request(app)
      .post(`/admin/users/${target.user.id}/deactivate`)
      .set("Cookie", admin.cookie)
      .set("Origin", "https://evil.test")
    expect(evil.status).toBe(403)
    const noOrigin = await request(app).post(`/admin/users/${target.user.id}/deactivate`).set("Cookie", admin.cookie)
    expect(noOrigin.status).toBe(403)
    const { rows } = await pool!.query<{ is_active: boolean }>("select is_active from users where id = $1", [target.user.id])
    expect(rows[0].is_active).toBe(true)

    const ok = await request(app)
      .post(`/admin/users/${target.user.id}/deactivate`)
      .set("Cookie", admin.cookie)
      .set("Origin", TRUSTED_ORIGIN)
    expect(ok.status).toBe(200)
  })

  it("a dashboard access cookie is not accepted as admin auth", async () => {
    const user = await signupUser("cs11-not-admin")
    const res = await request(app).get("/admin/me").set("Cookie", `chatmate360_access_token=${user.session.access_token}`)
    expect(res.status).toBe(401)
  })

  it("admin logout revokes server-side: replaying the old cookie gets 401", async () => {
    const admin = await createAdmin("cs11-admin-logout")
    const logout = await request(app).post("/admin/logout").set("Cookie", admin.cookie).set("Origin", TRUSTED_ORIGIN)
    expect(logout.status).toBe(200)
    expect(setCookies(logout).some((c) => c.startsWith(`${ADMIN_COOKIE}=;`))).toBe(true)

    expect((await request(app).get("/admin/me").set("Cookie", admin.cookie)).status).toBe(401)
    expect((await request(app).get("/admin/users").set(bearer(cookieValue(admin.login, ADMIN_COOKIE)))).status).toBe(401)
  })
})

describe("CS-11 review fixes", () => {
  it("an access token without a session id (sid) is rejected", async () => {
    const user = await signupUser("cs11-no-sid")
    const sidless = signAccessToken(user.user.id) // what a pre-CS-11 instance would issue
    expect((await request(app).get("/auth/me").set(bearer(sidless))).status).toBe(401)
    expect((await request(app).get("/auth/me").set(bearer(user.session.access_token))).status).toBe(200)
  })

  it("a refresh token created before the revocation watermark is refused (the outcome of a refresh racing a revoke)", async () => {
    const user = await signupUser("cs11-watermark-refresh")
    // Simulate a refresh that committed its new token while a revocation was
    // in flight: the token row survives, but the watermark is newer than it.
    await pool!.query("update users set tokens_valid_after = clock_timestamp() + interval '1 second' where id = $1", [user.user.id])
    const res = await request(app).post("/auth/refresh").send({ refresh_token: user.session.refresh_token })
    expect(res.status).toBe(401)
  })

  it("refresh and logout-all forced to overlap: the token the refresh returns is unusable", async () => {
    const user = await signupUser("cs11-overlap")

    // Hold the refresh transaction open at its COMMIT (after it has done all
    // its work, and in the fixed code after it took the users row lock), run
    // logout-all against it, then let the refresh commit. Wraps pool.connect,
    // which every explicit transaction in the app uses; armed for exactly one
    // COMMIT, the refresh's.
    let reachedCommit!: () => void
    const atCommit = new Promise<void>((resolve) => (reachedCommit = resolve))
    let releaseCommit!: () => void
    const commitGate = new Promise<void>((resolve) => (releaseCommit = resolve))
    let armed = true
    const realConnect = pool!.connect.bind(pool!) as () => Promise<import("pg").PoolClient>
    const connectSpy = vi.spyOn(pool!, "connect").mockImplementation((async () => {
      const client = await realConnect()
      if (!armed) return client
      const original = client.query
      client.query = (async (...args: unknown[]) => {
        const text = typeof args[0] === "string" ? args[0] : ""
        if (armed && /^\s*commit\b/i.test(text)) {
          armed = false
          client.query = original
          reachedCommit()
          await commitGate
        }
        return (original as (...a: unknown[]) => Promise<unknown>).apply(client, args)
      }) as typeof client.query
      return client
    }) as never)

    try {
      const refreshing = request(app)
        .post("/auth/refresh")
        .send({ refresh_token: user.session.refresh_token })
        .then((res) => res)
      await atCommit
      const revoking = request(app)
        .post("/auth/logout-all")
        .set(bearer(user.session.access_token))
        .then((res) => res)
      await new Promise((resolve) => setTimeout(resolve, 400)) // let logout-all reach its blocking statement
      releaseCommit()
      const [refreshed, revoked] = await Promise.all([refreshing, revoking])

      expect(revoked.status).toBe(200)
      expect(refreshed.status).toBe(200) // the refresh committed first
      const newRefresh = cookieValue(refreshed, "chatmate360_refresh_token")
      const newAccess = cookieValue(refreshed, "chatmate360_access_token")
      expect((await request(app).post("/auth/refresh").send({ refresh_token: newRefresh })).status).toBe(401)
      expect((await request(app).get("/auth/me").set(bearer(newAccess))).status).toBe(401)
      const { rows } = await pool!.query("select 1 from refresh_tokens where user_id = $1", [user.user.id])
      expect(rows).toHaveLength(0)
    } finally {
      armed = false
      releaseCommit()
      connectSpy.mockRestore()
    }
  })

  it("replaying an already-rotated refresh token (after the grace window) revokes the whole session", async () => {
    const user = await signupUser("cs11-reuse")
    const rotated = await request(app).post("/auth/refresh").send({ refresh_token: user.session.refresh_token })
    expect(rotated.status).toBe(200)
    const nextRefresh = cookieValue(rotated, "chatmate360_refresh_token")
    const nextAccess = cookieValue(rotated, "chatmate360_access_token")

    // Inside the grace window (two tabs racing) the old token is only refused.
    expect((await request(app).post("/auth/refresh").send({ refresh_token: user.session.refresh_token })).status).toBe(401)
    expect((await request(app).get("/auth/me").set(bearer(nextAccess))).status).toBe(200)

    await pool!.query("update refresh_tokens set rotated_at = clock_timestamp() - interval '5 minutes' where token_hash = $1", [
      hashRefreshToken(user.session.refresh_token),
    ])
    expect((await request(app).post("/auth/refresh").send({ refresh_token: user.session.refresh_token })).status).toBe(401)
    expect((await request(app).post("/auth/refresh").send({ refresh_token: nextRefresh })).status).toBe(401)
    expect((await request(app).get("/auth/me").set(bearer(nextAccess))).status).toBe(401)
  })

  it("admin endpoints no longer accept an Authorization: Bearer admin token", async () => {
    const admin = await createAdmin("cs11-admin-no-bearer")
    const token = cookieValue(admin.login, ADMIN_COOKIE)
    expect((await request(app).get("/admin/me").set(bearer(token))).status).toBe(401)
    expect((await request(app).get("/admin/me").set("Cookie", admin.cookie)).status).toBe(200)
  })

  it("POST /leads does not attach a lead to an account whose session was logged out", async () => {
    const user = await signupUser("cs11-lead")
    await request(app).post("/auth/logout").send({ refresh_token: user.session.refresh_token })
    const email = uniqueEmail("cs11-lead-contact")
    const res = await request(app)
      .post("/leads")
      .set(bearer(user.session.access_token))
      .send({ name: "Lead", email, phone: "+1 555 0100", selectedBots: ["Leads Agent"] })
    expect(res.status).toBe(201)
    const { rows } = await pool!.query<{ user_id: string | null }>("select user_id from leads where email = $1", [email])
    expect(rows[0].user_id).toBeNull()
  })
})

describe("CS-11 re-review fixes", () => {
  it("the migration does not sign dashboard users out: existing refresh tokens get a session id and keep working", async () => {
    // Run the real migration file against a scratch schema holding the
    // pre-CS-11 shape of the three tables, with one pre-existing user and
    // refresh token, plus one admin. The migration's column-existence guards
    // name the public schema; they are pointed at the scratch schema so its
    // one-time backfills run exactly as on a not-yet-migrated database.
    const schema = `cs11_mig_${randomUUID().replace(/-/g, "")}`
    const migration = readFileSync(new URL("../../db/migrations/20261114_revocable_sessions.sql", import.meta.url), "utf8")
      .replaceAll("table_schema = 'public'", `table_schema = '${schema}'`)
    const client = await pool!.connect()
    try {
      await client.query(`create schema ${schema}`)
      await client.query(`set search_path to ${schema}`)
      await client.query(`
        create table users (id uuid primary key default gen_random_uuid(), email text not null);
        create table admin_users (id uuid primary key default gen_random_uuid(), email text not null);
        create table refresh_tokens (
          id uuid primary key default gen_random_uuid(),
          user_id uuid not null references users(id) on delete cascade,
          token_hash text not null unique,
          expires_at timestamptz not null,
          created_at timestamptz not null default now()
        );
        insert into users (email) values ('pre-migration@example.test');
        insert into admin_users (email) values ('pre-migration-admin@example.test');
        insert into refresh_tokens (user_id, token_hash, expires_at, created_at)
          select id, 'pre-migration-hash', now() + interval '20 days', now() - interval '10 days' from users;`)
      await client.query(migration)
      const { rows } = await client.query<{ tokens_valid_after: Date | null; session_id: string | null }>(
        "select u.tokens_valid_after, r.session_id from users u join refresh_tokens r on r.user_id = u.id",
      )
      expect(rows).toHaveLength(1)
      expect(rows[0].tokens_valid_after).toBeNull()
      expect(rows[0].session_id).toMatch(/^[0-9a-f-]{36}$/)
      // Intended: admins sign in once more (old sessionStorage bearer tokens die).
      const { rows: admins } = await client.query<{ tokens_valid_after: Date | null }>("select tokens_valid_after from admin_users")
      expect(admins[0].tokens_valid_after).not.toBeNull()
    } finally {
      await client.query("reset search_path").catch(() => undefined)
      await client.query(`drop schema if exists ${schema} cascade`).catch(() => undefined)
      client.release()
    }
  })

  it("a refresh token created before the migration (old created_at, no watermark) still refreshes", async () => {
    const user = await signupUser("cs11-pre-migration")
    // What a pre-deploy session looks like once migrated: issued days ago,
    // session id backfilled, account never revoked.
    await pool!.query("update users set tokens_valid_after = null where id = $1", [user.user.id])
    await pool!.query(
      "update refresh_tokens set created_at = now() - interval '10 days', session_id = gen_random_uuid() where token_hash = $1",
      [hashRefreshToken(user.session.refresh_token)],
    )
    const res = await request(app).post("/auth/refresh").send({ refresh_token: user.session.refresh_token })
    expect(res.status).toBe(200)
    expect((await request(app).get("/auth/me").set(bearer(cookieValue(res, "chatmate360_access_token")))).status).toBe(200)
  })

  it("reuse inside the grace window from a different client (User-Agent) revokes the session", async () => {
    const email = uniqueEmail("cs11-grace-ua")
    const password = "correct horse battery staple"
    await request(app).post("/auth/signup").set("User-Agent", "Browser-A").send({ name: "UA", email, password })
    const login = await request(app).post("/auth/login").set("User-Agent", "Browser-A").send({ email, password })
    const first = cookieValue(login, "chatmate360_refresh_token")
    const rotated = await request(app).post("/auth/refresh").set("User-Agent", "Browser-A").send({ refresh_token: first })
    expect(rotated.status).toBe(200)
    const nextAccess = cookieValue(rotated, "chatmate360_access_token")

    // Same client, inside the grace window: refused, session kept.
    expect((await request(app).post("/auth/refresh").set("User-Agent", "Browser-A").send({ refresh_token: first })).status).toBe(401)
    expect((await request(app).get("/auth/me").set(bearer(nextAccess))).status).toBe(200)

    // Different client, inside the grace window: treated as theft.
    expect((await request(app).post("/auth/refresh").set("User-Agent", "Thief-B").send({ refresh_token: first })).status).toBe(401)
    expect((await request(app).get("/auth/me").set(bearer(nextAccess))).status).toBe(401)
  })
})

describe("CS-11 approval notes", () => {
  it("thief rotates first, real client replays within the grace window from its own User-Agent: session revoked", async () => {
    const email = uniqueEmail("cs11-thief-first")
    const password = "correct horse battery staple"
    await request(app).post("/auth/signup").set("User-Agent", "Real-Browser").send({ name: "Real", email, password })
    const login = await request(app).post("/auth/login").set("User-Agent", "Real-Browser").send({ email, password })
    const stolen = cookieValue(login, "chatmate360_refresh_token")

    const thief = await request(app).post("/auth/refresh").set("User-Agent", "Thief-Tool").send({ refresh_token: stolen })
    expect(thief.status).toBe(200)
    const thiefRefresh = cookieValue(thief, "chatmate360_refresh_token")
    const thiefAccess = cookieValue(thief, "chatmate360_access_token")

    // The real client's own refresh, seconds later, presents the token the thief already exchanged.
    expect((await request(app).post("/auth/refresh").set("User-Agent", "Real-Browser").send({ refresh_token: stolen })).status).toBe(401)

    expect((await request(app).get("/auth/me").set(bearer(thiefAccess))).status).toBe(401)
    expect((await request(app).post("/auth/refresh").set("User-Agent", "Thief-Tool").send({ refresh_token: thiefRefresh })).status).toBe(401)
  })

  it("dashboard login: a password change that lands while bcrypt runs yields 401 and no session", async () => {
    const user = await signupUser("cs11-login-race")
    const before = await pool!.query("select 1 from refresh_tokens where user_id = $1", [user.user.id])
    const realCompare = bcrypt.compare.bind(bcrypt) as (a: string, b: string) => Promise<boolean>
    const spy = vi.spyOn(bcrypt, "compare").mockImplementation((async (plain: string, hash: string) => {
      const ok = await realCompare(plain, hash)
      // A password reset commits mid-verification.
      await pool!.query("update users set password_hash = $1 where id = $2", [await hashPassword("reset-by-owner-123"), user.user.id])
      return ok
    }) as never)
    try {
      const res = await request(app).post("/auth/login").send({ email: user.email, password: user.password })
      expect(res.status).toBe(401)
      expect(setCookies(res).some((c) => c.startsWith("chatmate360_access_token=") && !/Expires=Thu, 01 Jan 1970/.test(c))).toBe(false)
    } finally {
      spy.mockRestore()
    }
    const after = await pool!.query("select 1 from refresh_tokens where user_id = $1", [user.user.id])
    expect(after.rows).toHaveLength(before.rows.length)
  })

  it("admin login: a credential change that lands while bcrypt runs yields 401 and no admin cookie", async () => {
    const email = uniqueEmail("cs11-admin-login-race")
    const password = "a very strong admin password"
    const { rows } = await pool!.query<{ id: string }>(
      "insert into admin_users (email, password_hash, name) values ($1, $2, 'Race Admin') returning id",
      [email, await hashPassword(password)],
    )
    const realCompare = bcrypt.compare.bind(bcrypt) as (a: string, b: string) => Promise<boolean>
    const spy = vi.spyOn(bcrypt, "compare").mockImplementation((async (plain: string, hash: string) => {
      const ok = await realCompare(plain, hash)
      // The spy runs inside the request's own (non-admin) context; after the
      // CS-15 lockdown only the system login can write admin_users.
      const rotated = await hashPassword("rotated-admin-pass-1")
      await runWithSystemContext(() => pool!.query("update admin_users set password_hash = $1 where id = $2", [rotated, rows[0].id]))
      return ok
    }) as never)
    try {
      const res = await request(app).post("/admin/login").send({ email, password })
      expect(res.status).toBe(401)
      expect(setCookies(res).some((c) => c.startsWith(`${ADMIN_COOKIE}=`))).toBe(false)
    } finally {
      spy.mockRestore()
    }
  })
})
