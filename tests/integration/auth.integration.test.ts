import request from "supertest"
import { describe, expect, it } from "vitest"

import { app, cookieValue, signupUser, uniqueEmail } from "../helpers.js"

describe("POST /auth/signup", () => {
  it("creates an account and returns a real session", async () => {
    const email = uniqueEmail("signup")
    const res = await request(app)
      .post("/auth/signup")
      .send({ name: "New User", email, password: "correct horse battery staple" })

    expect(res.status).toBe(201)
    expect(res.body.ok).toBe(true)
    expect(res.body.user.email).toBe(email)
    expect(res.body.user.chatbots).toEqual([])
    // Tokens are no longer in the response body at all (see
    // src/lib/authCookies.ts) — only in httpOnly Set-Cookie headers, which
    // JavaScript (and so a real XSS payload) can't read either the cookie
    // or, now, the body it used to also be duplicated into.
    expect(res.body.session).toBeUndefined()
    expect(cookieValue(res, "chatmate360_access_token")).toBeTypeOf("string")
    expect(cookieValue(res, "chatmate360_refresh_token")).toBeTypeOf("string")
  })

  it("rejects a duplicate email with 409, not a 500", async () => {
    const { email } = await signupUser("dup")
    const res = await request(app)
      .post("/auth/signup")
      .send({ name: "Second User", email, password: "another password" })

    expect(res.status).toBe(409)
    expect(res.body.ok).toBe(false)
  })

  it("rejects a weak/short password before ever touching the database", async () => {
    const res = await request(app)
      .post("/auth/signup")
      .send({ name: "New User", email: uniqueEmail("weak"), password: "short" })

    expect(res.status).toBe(400)
  })
})

describe("POST /auth/login", () => {
  it("logs in with the right password", async () => {
    const { email, password } = await signupUser("login-ok")
    const res = await request(app).post("/auth/login").send({ email, password })

    expect(res.status).toBe(200)
    expect(res.body.session).toBeUndefined()
    expect(cookieValue(res, "chatmate360_access_token")).toBeTypeOf("string")
  })

  it("rejects a wrong password with the same generic message as an unknown email (no user-enumeration leak)", async () => {
    const { email } = await signupUser("login-bad-pw")

    const wrongPassword = await request(app).post("/auth/login").send({ email, password: "totally wrong password" })
    const unknownEmail = await request(app)
      .post("/auth/login")
      .send({ email: uniqueEmail("never-signed-up"), password: "whatever password" })

    expect(wrongPassword.status).toBe(401)
    expect(unknownEmail.status).toBe(401)
    expect(wrongPassword.body.error).toBe(unknownEmail.body.error)
  })
})

describe("GET /auth/me", () => {
  it("returns the current user for a valid token", async () => {
    const { session, user } = await signupUser("me-ok")
    const res = await request(app).get("/auth/me").set("Authorization", `Bearer ${session.access_token}`)

    expect(res.status).toBe(200)
    expect(res.body.user.id).toBe(user.id)
  })

  it("rejects a missing Authorization header", async () => {
    const res = await request(app).get("/auth/me")
    expect(res.status).toBe(401)
  })

  it("rejects a malformed/garbage token", async () => {
    const res = await request(app).get("/auth/me").set("Authorization", "Bearer not-a-real-token")
    expect(res.status).toBe(401)
  })
})

describe("POST /auth/refresh", () => {
  it("rotates the refresh token — the old one is rejected after use", async () => {
    const { session } = await signupUser("refresh")

    const first = await request(app).post("/auth/refresh").send({ refresh_token: session.refresh_token })
    expect(first.status).toBe(200)
    expect(cookieValue(first, "chatmate360_refresh_token")).not.toBe(session.refresh_token)

    const replay = await request(app).post("/auth/refresh").send({ refresh_token: session.refresh_token })
    expect(replay.status).toBe(401)
  })
})

describe("POST /auth/logout", () => {
  it("revokes the refresh token", async () => {
    const { session } = await signupUser("logout")

    const logout = await request(app).post("/auth/logout").send({ refresh_token: session.refresh_token })
    expect(logout.status).toBe(200)

    const afterLogout = await request(app).post("/auth/refresh").send({ refresh_token: session.refresh_token })
    expect(afterLogout.status).toBe(401)
  })
})
