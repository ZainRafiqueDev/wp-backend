import jwt from "jsonwebtoken"
import request from "supertest"
import { describe, expect, it, vi } from "vitest"

// This suite is about injection/tampering resistance, not quota-based
// model selection (Phase C) — mocked out so a real, possibly-rate-limited-
// by-the-provider-itself Gemini call never adds real network latency to a
// loop firing several requests per test (this sandbox's real
// GEMINI_API_KEY has hit its own quota before, adding a slow failing round
// trip before falling through to OpenAI). Falls back to lib/ai.ts's normal
// fixed try-order, same as before Phase C. See the matching comment in
// tests/integration/public.integration.test.ts.
// CS-17 (B09-001): no live provider calls — deterministic fake completions.
vi.mock("../../src/lib/ai.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/ai.js")>()
  const { fakeAnswerQuestion } = await import("../helpers/fakeAi.js")
  return { ...actual, answerQuestion: vi.fn(fakeAnswerQuestion), completeCheaply: vi.fn(async () => null) }
})

vi.mock("../../src/services/modelSelection.service.js", () => ({
  selectModelForNewConversation: vi.fn(async () => null),
  selectModelForConversation: vi.fn(async () => null),
}))

const { env } = await import("../../src/env.js")
const { app, cookieValue, signupUser, uniqueEmail } = await import("../helpers.js")
const { crawlWebsiteForChatbot, runCrawlJob } = await import("../../src/services/chatbot.service.js")

function authed(token: string) {
  return { Authorization: `Bearer ${token}` }
}

describe("JWT tampering", () => {
  it("rejects a token re-signed with a different secret", async () => {
    const forged = jwt.sign({ sub: "some-user-id", typ: "access" }, "an-attackers-guess-at-the-secret")
    const res = await request(app).get("/auth/me").set("Authorization", `Bearer ${forged}`)
    expect(res.status).toBe(401)
  })

  it("rejects a token with a flipped signature character", async () => {
    const { session } = await signupUser("jwt-tamper")
    const token = session.access_token
    const tampered = token.slice(0, -2) + (token.at(-2) === "a" ? "b" : "a") + token.at(-1)
    const res = await request(app).get("/auth/me").set("Authorization", `Bearer ${tampered}`)
    expect(res.status).toBe(401)
  })

  it("rejects a refresh token replayed as an access token, even though both are signed with the same secret", async () => {
    const { session } = await signupUser("jwt-cross-use")
    const res = await request(app).get("/auth/me").set("Authorization", `Bearer ${session.refresh_token}`)
    expect(res.status).toBe(401)
  })
})

describe("SQL injection resistance", () => {
  const PAYLOADS = ["' OR '1'='1", "'; DROP TABLE users; --", "\" OR 1=1 --", "'; SELECT pg_sleep(3); --"]

  it("a classic injection payload as the login email is just an invalid login, not an auth bypass or a crash", async () => {
    for (const payload of PAYLOADS) {
      const res = await request(app).post("/auth/login").send({ email: payload, password: "whatever12345" })
      // Either 400 (fails email validation) or 401 (valid shape, no match) —
      // never 200 (bypass) and never 500 (unhandled DB error).
      expect([400, 401]).toContain(res.status)
    }
  })

  it("an injection payload as the chatbot domain is stored/rejected safely, never crashes the request", async () => {
    const { session } = await signupUser("sqli-domain")
    const created = await request(app)
      .post("/chatbots")
      .set(authed(session.access_token))
      .send({ name: "bot", sources: [{ type: "pdf", label: "a.pdf", characters: 5, content: "x" }] })
    const chatbotId = created.body.chatbot.id as string

    for (const payload of PAYLOADS) {
      const res = await request(app).patch(`/chatbots/${chatbotId}/domain`).set(authed(session.access_token)).send({ domain: payload })
      expect(res.status).not.toBe(500)
    }
  })

  it("an injection payload as a chat question never crashes the request", async () => {
    const { session } = await signupUser("sqli-question")
    const created = await request(app)
      .post("/chatbots")
      .set(authed(session.access_token))
      .send({ name: "bot", sources: [{ type: "pdf", label: "a.pdf", characters: 5, content: "support info" }] })
    const chatbotId = created.body.chatbot.id as string

    for (const payload of PAYLOADS) {
      const res = await request(app)
        .post(`/chatbots/${chatbotId}/chat`)
        .set(authed(session.access_token))
        .send({ question: payload, history: [] })
      expect(res.status).not.toBe(500)
    }
  })
})

describe("no internal detail ever leaks in a response body", () => {
  it("password_hash never appears in signup, login, or /me responses", async () => {
    const email = uniqueEmail("no-leak")
    const signup = await request(app).post("/auth/signup").send({ name: "Test", email, password: "correct horse battery staple" })
    expect(JSON.stringify(signup.body)).not.toContain("password_hash")

    const login = await request(app).post("/auth/login").send({ email, password: "correct horse battery staple" })
    expect(JSON.stringify(login.body)).not.toContain("password_hash")

    const me = await request(app).get("/auth/me").set("Authorization", `Bearer ${cookieValue(login, "chatmate360_access_token")}`)
    expect(JSON.stringify(me.body)).not.toContain("password_hash")
  })
})

describe("CORS", () => {
  it("sends a deny-everything Content-Security-Policy (the API never serves HTML)", async () => {
    const res = await request(app).get("/health")
    const csp = res.headers["content-security-policy"]
    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain("frame-ancestors 'none'")
  })

  it("Access-Control-Allow-Origin only ever reflects FRONTEND_URL, never an arbitrary request Origin", async () => {
    const fromEvil = await request(app).get("/health").set("Origin", "https://evil.example")
    if (fromEvil.headers["access-control-allow-origin"]) {
      expect(fromEvil.headers["access-control-allow-origin"]).toBe(env.frontendUrl)
      expect(fromEvil.headers["access-control-allow-origin"]).not.toBe("https://evil.example")
    }

    const fromReal = await request(app).get("/health").set("Origin", env.frontendUrl)
    expect(fromReal.headers["access-control-allow-origin"]).toBe(env.frontendUrl)
  })
})

describe("SSRF defense on the real (unmocked) crawl path", () => {
  it("crawlWebsiteForChatbot fails closed against a private/loopback target", async () => {
    await expect(crawlWebsiteForChatbot("http://127.0.0.1/")).rejects.toMatchObject({ status: 422 })
  })

  it("crawlWebsiteForChatbot fails closed against the cloud metadata endpoint", async () => {
    await expect(crawlWebsiteForChatbot("http://169.254.169.254/latest/meta-data/")).rejects.toMatchObject({
      status: 422,
    })
  })

  it("a chatbot created against a private-IP websiteUrl ends up failed, never silently ready with internal content", async () => {
    const { session } = await signupUser("ssrf-e2e")
    const created = await request(app)
      .post("/chatbots")
      .set(authed(session.access_token))
      .send({ name: "internal", websiteUrl: "http://127.0.0.1:1/" })
    const chatbotId = created.body.chatbot.id

    await expect(runCrawlJob(chatbotId, "http://127.0.0.1:1/")).rejects.toThrow()

    const status = await request(app).get(`/chatbots/${chatbotId}`).set(authed(session.access_token))
    expect(status.body.chatbot.status).toBe("failed")
  })
})
