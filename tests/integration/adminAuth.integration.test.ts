import request from "supertest"
import { describe, expect, it } from "vitest"

import { hashPassword } from "../../src/lib/auth.js"
import { pool } from "../../src/lib/db.js"
import { app, cookieValue, signupUser, uniqueEmail } from "../helpers.js"

async function createAdmin(label: string) {
  const email = uniqueEmail(label)
  const password = "a very strong admin password"
  const passwordHash = await hashPassword(password)
  await pool!.query(// SA-02: these tests exercise super-admin-only actions (plans, delete).
    "insert into admin_users (email, password_hash, name, role) values ($1, $2, $3, 'super_admin')", [
    email,
    passwordHash,
    "Test Admin",
  ])
  const login = await request(app).post("/admin/login").send({ email, password })
  if (login.status !== 200) throw new Error(`createAdmin helper failed: ${login.status} ${JSON.stringify(login.body)}`)
  return cookieValue(login, "chatmate360_admin_token") // CS-11: token is only in the httpOnly cookie now
}

function authed(token: string) {
  return { Authorization: `Bearer ${token}` }
}

// CS-11: admin auth is cookie-only; state-changing requests also need the
// trusted Origin (requireTrustedOrigin).
function adminAuthed(token: string) {
  return { Cookie: `chatmate360_admin_token=${token}`, Origin: "https://frontend.test" }
}

describe("Admin auth isolation (Section 1/9)", () => {
  it("rejects every /admin/* route without a token", async () => {
    expect((await request(app).get("/admin/users")).status).toBe(401)
    expect((await request(app).post("/admin/users/00000000-0000-0000-0000-000000000000/deactivate")).status).toBe(401)
  })

  it("a customer access token is rejected on an admin route (typ: 'access' is not typ: 'admin')", async () => {
    const { session } = await signupUser("admin-isolation-customer")
    const res = await request(app).get("/admin/users").set(authed(session.access_token))
    expect(res.status).toBe(401)
  })

  it("a real admin token is rejected on a customer route (typ: 'admin' is not typ: 'access')", async () => {
    const adminToken = await createAdmin("admin-isolation-admin")
    const res = await request(app).get("/auth/me").set(adminAuthed(adminToken))
    expect(res.status).toBe(401)
  })

  it("a real admin token works on admin routes and can list users", async () => {
    const adminToken = await createAdmin("admin-list")
    await signupUser("admin-list-target")

    const res = await request(app).get("/admin/users").set(adminAuthed(adminToken))
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body.users)).toBe(true)
    expect(res.body.users.length).toBeGreaterThan(0)
  })

  it("deactivating a user via the admin route blocks their login, and activating restores it", async () => {
    const adminToken = await createAdmin("admin-deactivate")
    const { session, email, password } = await signupUser("admin-deactivate-target")

    const before = await request(app).get("/auth/me").set(authed(session.access_token))
    expect(before.status).toBe(200)

    const meRes = await request(app).get("/auth/me").set(authed(session.access_token))
    const userId = meRes.body.user.id as string

    const deactivate = await request(app).post(`/admin/users/${userId}/deactivate`).set(adminAuthed(adminToken))
    expect(deactivate.status).toBe(200)

    const loginAttempt = await request(app).post("/auth/login").send({ email, password })
    expect(loginAttempt.status).toBe(403)
    expect(loginAttempt.body.error).toMatch(/deactivated/i)

    const reactivate = await request(app).post(`/admin/users/${userId}/activate`).set(adminAuthed(adminToken))
    expect(reactivate.status).toBe(200)
  })

  it("DELETE requires an explicit confirm:true body, and actually removes the user on confirmation", async () => {
    const adminToken = await createAdmin("admin-delete")
    const { session } = await signupUser("admin-delete-target")
    const meRes = await request(app).get("/auth/me").set(authed(session.access_token))
    const userId = meRes.body.user.id as string

    const withoutConfirm = await request(app).delete(`/admin/users/${userId}`).set(adminAuthed(adminToken)).send({})
    expect(withoutConfirm.status).toBe(400)

    const withConfirm = await request(app)
      .delete(`/admin/users/${userId}`)
      .set(adminAuthed(adminToken))
      .send({ confirm: true })
    expect(withConfirm.status).toBe(200)

    const { rows } = await pool!.query("select 1 from users where id = $1", [userId])
    expect(rows).toHaveLength(0)
  })
})
