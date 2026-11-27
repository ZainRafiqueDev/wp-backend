import { randomUUID } from "node:crypto"

import request from "supertest"
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"

// src/env.ts reads these once at import time, so they must be set before the
// app is imported below. Dummy values only; Google is never contacted — every
// request to Google's token/userinfo endpoints is answered by the fetch mock.
vi.hoisted(() => {
  process.env.GOOGLE_CLIENT_ID = "cs05-test-client-id"
  process.env.GOOGLE_CLIENT_SECRET = "cs05-test-client-secret"
  process.env.GOOGLE_REDIRECT_URI = "https://api.test/auth/google/callback"
})

import { GOOGLE_OAUTH_STATE_COOKIE } from "../../src/lib/auth.js"
import { app, cookieValue, signupUser, uniqueEmail } from "../helpers.js"
import { pool } from "../../src/lib/db.js"

const FRONTEND_CALLBACK = "https://frontend.test/auth/callback"

type Profile = { sub: string; email: string; email_verified: boolean; name?: string }

// code -> Google profile the mocked userinfo endpoint returns for it.
const profilesByCode = new Map<string, Profile>()
const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
  if (url === "https://oauth2.googleapis.com/token") {
    const code = new URLSearchParams(String(init?.body)).get("code") ?? ""
    if (!profilesByCode.has(code)) {
      return new Response(JSON.stringify({ error: "invalid_grant", error_description: "Bad code" }), { status: 400 })
    }
    return new Response(JSON.stringify({ access_token: `at-${code}` }), { status: 200 })
  }
  if (url === "https://www.googleapis.com/oauth2/v3/userinfo") {
    const auth = new Headers(init?.headers).get("authorization") ?? ""
    const profile = profilesByCode.get(auth.replace(/^Bearer at-/, ""))
    if (!profile) return new Response("{}", { status: 401 })
    return new Response(JSON.stringify(profile), { status: 200 })
  }
  throw new Error(`unexpected network call in test: ${url}`)
})

afterAll(() => {
  fetchMock.mockRestore()
})

beforeEach(() => {
  fetchMock.mockClear()
})

function googleCode(profile: Profile): string {
  const code = `code-${randomUUID()}`
  profilesByCode.set(code, profile)
  return code
}

function tokenExchangeCalls(): number {
  return fetchMock.mock.calls.filter(([input]) => String(input) === "https://oauth2.googleapis.com/token").length
}

/** Mimics the browser: POST /auth/google -> navigate to returned url -> follow to Google. */
async function startFlow(): Promise<{ state: string; nonce: string; setCookie: string }> {
  const post = await request(app).post("/auth/google")
  expect(post.status).toBe(200)
  expect(post.body).toEqual({ ok: true, url: "https://api.test/auth/google/start" })

  const start = await request(app).get("/auth/google/start")
  expect(start.status).toBe(302)
  const google = new URL(start.headers.location)
  expect(google.origin + google.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth")
  expect(google.searchParams.get("redirect_uri")).toBe("https://api.test/auth/google/callback")
  const state = google.searchParams.get("state") ?? ""
  expect(state).not.toBe("")

  const raw = start.headers["set-cookie"] as unknown as string[]
  const setCookie = raw.find((c) => c.startsWith(`${GOOGLE_OAUTH_STATE_COOKIE}=`)) ?? ""
  return { state, nonce: cookieValue(start, GOOGLE_OAUTH_STATE_COOKIE), setCookie }
}

function callback(code: string, state: string, nonce?: string) {
  const req = request(app).get(
    `/auth/google/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
  )
  return nonce === undefined ? req : req.set("Cookie", `${GOOGLE_OAUTH_STATE_COOKIE}=${nonce}`)
}

function expectSignedIn(res: request.Response) {
  expect(res.status).toBe(302)
  expect(res.headers.location).toBe(FRONTEND_CALLBACK)
  expect(cookieValue(res, "chatmate360_access_token")).toBeTypeOf("string")
  return cookieValue(res, "chatmate360_refresh_token")
}

function expectRejected(res: request.Response) {
  expect(res.status).toBe(302)
  expect(res.headers.location.startsWith(`${FRONTEND_CALLBACK}?error_description=`)).toBe(true)
  const cookies = ([] as string[]).concat(res.headers["set-cookie"] ?? [])
  expect(cookies.some((c) => c.startsWith("chatmate360_access_token=") && !/Expires=Thu, 01 Jan 1970/.test(c))).toBe(false)
}

describe("Google OAuth state is bound to the initiating browser", () => {
  it("sets a short-lived httpOnly SameSite=Lax nonce cookie when the flow starts", async () => {
    const { setCookie } = await startFlow()
    expect(setCookie).toMatch(/HttpOnly/i)
    expect(setCookie).toMatch(/SameSite=Lax/i)
    expect(setCookie).toMatch(/Max-Age=600/)
  })

  it("rejects a callback with no state cookie and never exchanges the code", async () => {
    const { state } = await startFlow()
    const code = googleCode({ sub: randomUUID(), email: uniqueEmail("cs05-nocookie"), email_verified: true })
    expectRejected(await callback(code, state))
    expect(tokenExchangeCalls()).toBe(0)
  })

  it("rejects a callback whose state was minted for a different browser (login CSRF)", async () => {
    const attacker = await startFlow()
    const victim = await startFlow()
    const code = googleCode({ sub: randomUUID(), email: uniqueEmail("cs05-csrf"), email_verified: true })
    // Attacker's state + code delivered to the victim's browser, which carries its own nonce.
    expectRejected(await callback(code, attacker.state, victim.nonce))
    expect(tokenExchangeCalls()).toBe(0)
  })

  it("rejects a missing state parameter", async () => {
    const { nonce } = await startFlow()
    const code = googleCode({ sub: randomUUID(), email: uniqueEmail("cs05-nostate"), email_verified: true })
    expectRejected(await callback(code, "", nonce))
  })

  it("clears the nonce cookie and accepts each state only once", async () => {
    const { state, nonce } = await startFlow()
    const profile = { sub: randomUUID(), email: uniqueEmail("cs05-replay"), email_verified: true }
    const first = await callback(googleCode(profile), state, nonce)
    expectSignedIn(first)
    const cleared = ([] as string[]).concat(first.headers["set-cookie"] ?? [])
    expect(cleared.some((c) => c.startsWith(`${GOOGLE_OAUTH_STATE_COOKIE}=;`))).toBe(true)

    expectRejected(await callback(googleCode(profile), state, nonce))
  })
})

describe("Google sign-in linking to an existing account", () => {
  it("happy path: a new Google user is created and signed in", async () => {
    const email = uniqueEmail("cs05-new")
    const { state, nonce } = await startFlow()
    const refresh = expectSignedIn(await callback(googleCode({ sub: randomUUID(), email, email_verified: true }), state, nonce))
    const me = await request(app).post("/auth/refresh").send({ refresh_token: refresh })
    expect(me.status).toBe(200)
  })

  it("pre-registered unverified account: attacker's password and sessions stop working after the owner signs in with Google", async () => {
    const victimEmail = uniqueEmail("cs05-takeover")
    const attackerPassword = "attacker chosen password 123"
    const signup = await request(app)
      .post("/auth/signup")
      .send({ name: "Not The Owner", email: victimEmail, password: attackerPassword })
    expect(signup.status).toBe(201)
    const attackerRefresh = cookieValue(signup, "chatmate360_refresh_token")
    const userId = signup.body.user.id as string

    const googleSub = `cs05-${randomUUID()}`
    const { state, nonce } = await startFlow()
    const ownerRefresh = expectSignedIn(
      await callback(googleCode({ sub: googleSub, email: victimEmail, email_verified: true }), state, nonce),
    )

    // Attacker's password no longer signs in.
    const attackerLogin = await request(app).post("/auth/login").send({ email: victimEmail, password: attackerPassword })
    expect(attackerLogin.status).toBe(401)

    // Attacker's pre-existing session is revoked.
    const attackerRefreshRes = await request(app).post("/auth/refresh").send({ refresh_token: attackerRefresh })
    expect(attackerRefreshRes.status).toBe(401)

    // The real owner's Google session is intact and is the same account.
    const ownerRefreshRes = await request(app).post("/auth/refresh").send({ refresh_token: ownerRefresh })
    expect(ownerRefreshRes.status).toBe(200)

    const { rows } = await pool!.query<{ google_id: string; password_hash: string | null; email_verified: boolean }>(
      "select google_id, password_hash, email_verified from users where id = $1",
      [userId],
    )
    expect(rows[0]).toEqual({ google_id: googleSub, password_hash: null, email_verified: true })
  })

  it("verified password account: Google is linked and the password and existing session keep working", async () => {
    const { email, password, session, user } = await signupUser("cs05-verified")
    const googleSub = `cs05-${randomUUID()}`
    const { state, nonce } = await startFlow()
    expectSignedIn(await callback(googleCode({ sub: googleSub, email, email_verified: true }), state, nonce))

    const login = await request(app).post("/auth/login").send({ email, password })
    expect(login.status).toBe(200)
    const refresh = await request(app).post("/auth/refresh").send({ refresh_token: session.refresh_token })
    expect(refresh.status).toBe(200)

    const { rows } = await pool!.query<{ google_id: string }>("select google_id from users where id = $1", [user.id])
    expect(rows[0].google_id).toBe(googleSub)
  })
})
