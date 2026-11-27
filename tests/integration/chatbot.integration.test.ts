import request from "supertest"
import { beforeEach, describe, expect, it, vi } from "vitest"

// Mocked at the crawler-module boundary, not on chatbot.service.ts itself —
// runCrawlJob's internal call to crawlWebsiteForChatbot is a same-file
// function reference, which a mock of chatbot.service.ts's own exports
// would NOT intercept (a well-known ESM mocking gotcha: intra-module calls
// don't go through the mocked export binding). crawlWebsite is a genuine
// cross-module import, so mocking it here really does control what
// crawlWebsiteForChatbot (and therefore runCrawlJob) sees.
const { crawlWebsiteMock } = vi.hoisted(() => ({ crawlWebsiteMock: vi.fn() }))
vi.mock("../../src/lib/crawler/crawl.js", () => ({ crawlWebsite: crawlWebsiteMock }))

const { app, signupUser } = await import("../helpers.js")
const { runCrawlJob } = await import("../../src/services/chatbot.service.js")

function authed(token: string) {
  return { Authorization: `Bearer ${token}` }
}

beforeEach(() => {
  crawlWebsiteMock.mockReset()
})

describe("POST /chatbots — file-only (synchronous)", () => {
  it("creates a chatbot that's ready immediately, no crawl involved", async () => {
    const { session } = await signupUser("chatbot-files")
    const res = await request(app)
      .post("/chatbots")
      .set(authed(session.access_token))
      .send({
        name: "My Docs Bot",
        sources: [{ type: "pdf", label: "handbook.pdf", characters: 500, content: "handbook content" }],
      })

    expect(res.status).toBe(201)
    expect(res.body.chatbot.status).toBe("ready")
    expect(crawlWebsiteMock).not.toHaveBeenCalled()
  })

  it("requires at least a website URL or a file source", async () => {
    const { session } = await signupUser("chatbot-empty")
    const res = await request(app).post("/chatbots").set(authed(session.access_token)).send({ name: "Empty Bot" })
    expect(res.status).toBe(400)
  })
})

describe("POST /chatbots — websiteUrl (async crawl)", () => {
  it("returns immediately with status queued, without waiting on the crawl", async () => {
    const { session } = await signupUser("chatbot-async")
    const res = await request(app)
      .post("/chatbots")
      .set(authed(session.access_token))
      .send({ name: "example.com", websiteUrl: "https://example.com/" })

    expect(res.status).toBe(201)
    expect(res.body.chatbot.status).toBe("queued")
    expect(crawlWebsiteMock).not.toHaveBeenCalled() // enqueued, not run inline
  })

  it("runCrawlJob takes it queued -> ready with merged sources on success", async () => {
    const { session } = await signupUser("chatbot-crawl-ok")
    const created = await request(app)
      .post("/chatbots")
      .set(authed(session.access_token))
      .send({
        name: "example.com",
        websiteUrl: "https://example.com/",
        sources: [{ type: "pdf", label: "extra.pdf", characters: 10, content: "extra" }],
      })
    const chatbotId = created.body.chatbot.id

    crawlWebsiteMock.mockResolvedValueOnce({
      siteTitle: "Example Site",
      pages: [{ path: "/", title: "Home", text: "Example content" }],
    })

    await runCrawlJob(chatbotId, "https://example.com/")

    const status = await request(app).get(`/chatbots/${chatbotId}`).set(authed(session.access_token))
    expect(status.body.chatbot.status).toBe("ready")
    expect(status.body.chatbot.name).toBe("Example Site")
    const types = status.body.chatbot.sources.map((s: { type: string }) => s.type)
    expect(types).toContain("pdf") // original file source preserved
    expect(types).toContain("website") // crawled source added
  })

  it("runCrawlJob takes it queued -> failed with a stored reason on crawl error, not stuck", async () => {
    const { session } = await signupUser("chatbot-crawl-fail")
    const created = await request(app)
      .post("/chatbots")
      .set(authed(session.access_token))
      .send({ name: "unreachable.example", websiteUrl: "https://unreachable.example/" })
    const chatbotId = created.body.chatbot.id

    crawlWebsiteMock.mockRejectedValueOnce(new Error("Couldn't reach that website."))

    await expect(runCrawlJob(chatbotId, "https://unreachable.example/")).rejects.toThrow()

    const status = await request(app).get(`/chatbots/${chatbotId}`).set(authed(session.access_token))
    expect(status.body.chatbot.status).toBe("failed")
    // crawlWebsiteForChatbot wraps any underlying crawler error into one of
    // its own two fixed, user-readable messages — the raw mock message
    // never reaches storage, by design (see chatbot.service.ts).
    expect(status.body.chatbot.statusReason).toBe("Couldn't reach that website. Check the URL and try again.")
  })
})

// Free-plan-specific limit enforcement (upgrade-message wording, multiple
// plans/tiers) is covered in detail by trialLimits.integration.test.ts —
// this just confirms the basic reject-when-at-limit behavior still holds
// for the default (free) plan a fresh signup gets.
describe("free-plan 1-chatbot limit", () => {
  it("blocks a second chatbot while the first is still queued/ready", async () => {
    const { session } = await signupUser("chatbot-limit")
    await request(app)
      .post("/chatbots")
      .set(authed(session.access_token))
      .send({ name: "first", websiteUrl: "https://example.com/" })

    const second = await request(app)
      .post("/chatbots")
      .set(authed(session.access_token))
      .send({ name: "second", websiteUrl: "https://example.com/" })

    expect(second.status).toBe(409)
  })
})

// PHASE A — retrying a specific failed chatbot's crawl is now its own
// endpoint (POST /chatbots/:chatbotId/retry), which reuses the same row
// (same id) rather than POST /chatbots implicitly detecting and updating
// an existing failed one — that implicit behavior only ever made sense
// when an account could have at most one chatbot to begin with.
describe("POST /chatbots/:chatbotId/retry", () => {
  it("retries a failed chatbot's crawl by id, reusing the same row", async () => {
    const { session } = await signupUser("chatbot-retry")
    const created = await request(app)
      .post("/chatbots")
      .set(authed(session.access_token))
      .send({ name: "first", websiteUrl: "https://example.com/" })
    const chatbotId = created.body.chatbot.id

    crawlWebsiteMock.mockRejectedValueOnce(new Error("failed"))
    await expect(runCrawlJob(chatbotId, "https://example.com/")).rejects.toThrow()

    const retry = await request(app)
      .post(`/chatbots/${chatbotId}/retry`)
      .set(authed(session.access_token))
      .send({ websiteUrl: "https://example.com/" })

    expect(retry.status).toBe(200)
    expect(retry.body.chatbot.id).toBe(chatbotId)
    expect(retry.body.chatbot.status).toBe("queued")
  })

  it("rejects retrying a chatbot that isn't in the failed state", async () => {
    const { session } = await signupUser("chatbot-retry-not-failed")
    const created = await request(app)
      .post("/chatbots")
      .set(authed(session.access_token))
      .send({ name: "ready bot", sources: [{ type: "pdf", label: "a.pdf", characters: 5, content: "x" }] })
    const chatbotId = created.body.chatbot.id

    const retry = await request(app)
      .post(`/chatbots/${chatbotId}/retry`)
      .set(authed(session.access_token))
      .send({ websiteUrl: "https://example.com/" })

    expect(retry.status).toBe(400)
  })

  it("never lets one user retry another user's chatbot", async () => {
    const owner = await signupUser("chatbot-retry-owner")
    const created = await request(app)
      .post("/chatbots")
      .set(authed(owner.session.access_token))
      .send({ name: "first", websiteUrl: "https://example.com/" })
    const chatbotId = created.body.chatbot.id
    crawlWebsiteMock.mockRejectedValueOnce(new Error("failed"))
    await expect(runCrawlJob(chatbotId, "https://example.com/")).rejects.toThrow()

    const attacker = await signupUser("chatbot-retry-attacker")
    const retry = await request(app)
      .post(`/chatbots/${chatbotId}/retry`)
      .set(authed(attacker.session.access_token))
      .send({ websiteUrl: "https://example.com/" })

    expect(retry.status).toBe(404)
  })
})

describe("PATCH endpoints", () => {
  it("updates theme, domain, and fallback message", async () => {
    const { session } = await signupUser("chatbot-patch")
    const created = await request(app)
      .post("/chatbots")
      .set(authed(session.access_token))
      .send({ name: "bot", sources: [{ type: "pdf", label: "a.pdf", characters: 5, content: "x" }] })
    const chatbotId = created.body.chatbot.id

    const theme = await request(app)
      .patch(`/chatbots/${chatbotId}/theme`)
      .set(authed(session.access_token))
      .send({ theme: { primaryColor: "#111111", bgColor: "#ffffff", textColor: "#000000" } })
    expect(theme.status).toBe(200)
    expect(theme.body.chatbot.theme.primaryColor).toBe("#111111")

    const domain = await request(app)
      .patch(`/chatbots/${chatbotId}/domain`)
      .set(authed(session.access_token))
      .send({ domain: "https://example.com/some/path" })
    expect(domain.status).toBe(200)
    expect(domain.body.chatbot.allowedDomain).toBe("example.com")

    const fallback = await request(app)
      .patch(`/chatbots/${chatbotId}/fallback-message`)
      .set(authed(session.access_token))
      .send({ fallbackMessage: "Ask me about our docs instead!" })
    expect(fallback.status).toBe(200)
    expect(fallback.body.chatbot.fallbackMessage).toBe("Ask me about our docs instead!")
  })
})

describe("POST /chatbots/:chatbotId/chat", () => {
  it("requires authentication", async () => {
    const res = await request(app)
      .post("/chatbots/00000000-0000-0000-0000-000000000000/chat")
      .send({ question: "hi", history: [] })
    expect(res.status).toBe(401)
  })
})
