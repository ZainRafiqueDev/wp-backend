import { randomUUID } from "node:crypto"

import request from "supertest"
import { describe, expect, it } from "vitest"

import { hashPassword } from "../../src/lib/auth.js"
import { pool } from "../../src/lib/db.js"
import { app, cookieValue, signupUser, uniqueEmail } from "../helpers.js"

async function createAdmin(label: string) {
  const email = uniqueEmail(label)
  const password = "a very strong admin password"
  const passwordHash = await hashPassword(password)
  await pool!.query("insert into admin_users (email, password_hash, name) values ($1, $2, $3)", [
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

// GET /admin/users was hard-capped at 200 rows with no way to see further
// accounts at all — silently wrong once the platform passed that many
// customers. This suite covers the limit/offset pagination that replaced it.
describe("GET /admin/users — pagination", () => {
  it("defaults to page size 50 and reports the real total via X-Total-Count and the response body", async () => {
    const adminToken = await createAdmin("admin-page-default")
    await signupUser("admin-page-default-target")

    const res = await request(app).get("/admin/users").set(adminAuthed(adminToken))
    expect(res.status).toBe(200)
    expect(res.body.users.length).toBeLessThanOrEqual(50)
    expect(typeof res.body.totalCount).toBe("number")
    expect(res.body.totalCount).toBeGreaterThan(0)
    expect(Number(res.headers["x-total-count"])).toBe(res.body.totalCount)
  })

  it("respects an explicit limit and offset", async () => {
    const adminToken = await createAdmin("admin-page-limit")
    // CS-17: the users table is shared with every other test file running in
    // parallel, so paging over ALL users raced with their signups (a new row
    // at the top shifted offset 1 onto the row page 1 had just returned).
    // Page over only this test's own users, found by a unique search tag.
    const tag = `pg${randomUUID().split("-").join("").slice(0, 12)}`
    await signupUser(`${tag}-a`)
    await signupUser(`${tag}-b`)
    await signupUser(`${tag}-c`)

    const pages: { id: string }[][] = []
    for (let offset = 0; offset < 4; offset++) {
      const res = await request(app).get(`/admin/users?limit=1&offset=${offset}&search=${tag}`).set(adminAuthed(adminToken))
      expect(res.status).toBe(200)
      expect(res.body.totalCount).toBe(3)
      pages.push(res.body.users as { id: string }[])
    }
    expect(pages.slice(0, 3).map((p) => p.length)).toEqual([1, 1, 1])
    expect(pages[3]).toHaveLength(0)
    const ids = pages.slice(0, 3).map((p) => p[0].id)
    expect(new Set(ids).size).toBe(3)
  })

  it("clamps limit to a maximum of 100 rather than trusting a client-supplied value", async () => {
    const adminToken = await createAdmin("admin-page-clamp")
    const res = await request(app).get("/admin/users?limit=100000").set(adminAuthed(adminToken))
    expect(res.status).toBe(200)
    expect(res.body.users.length).toBeLessThanOrEqual(100)
  })

  it("falls back to defaults on a nonsensical limit/offset instead of erroring", async () => {
    const adminToken = await createAdmin("admin-page-invalid")
    const res = await request(app).get("/admin/users?limit=not-a-number&offset=-5").set(adminAuthed(adminToken))
    expect(res.status).toBe(200)
    expect(res.body.users.length).toBeLessThanOrEqual(50)
  })
})
