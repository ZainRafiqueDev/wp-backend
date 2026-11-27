import type { Request, Response } from "express"
import { RateLimiterRedis } from "rate-limiter-flexible"
import { afterEach, describe, expect, it, vi } from "vitest"

import { rateLimitAdminLogin } from "../../src/middleware/rateLimitAdminLogin.js"
import { rateLimitAuthenticatedChat } from "../../src/middleware/rateLimitAuthenticatedChat.js"
import {
  rateLimitLogin,
  rateLimitOtpSend,
  rateLimitOtpVerify,
  rateLimitPasswordForgot,
} from "../../src/middleware/rateLimitAuthFlows.js"
import { rateLimitPublicChat } from "../../src/middleware/rateLimitPublic.js"
import { rateLimitPublicAttachment } from "../../src/middleware/rateLimitPublicAttachment.js"
import { signAccessToken } from "../../src/lib/auth.js"

// All five limiter files now share one consumeOrFailOpen (rateLimitShared.ts)
// instead of each duplicating the same msBeforeNext check inline. This
// suite proves every one of them still fails OPEN on an infra error
// (mocked here as RateLimiterRedis.prototype.consume rejecting with a raw
// Error — indistinguishable at this layer from a real Redis outage) while
// still failing CLOSED (429) on a real quota breach (a rejection carrying
// msBeforeNext). rateLimitAdminLogin and rateLimitPublicAttachment also
// configure an insuranceLimiter — see rateLimitInsuranceLimiter.test.ts for
// a test of that fallback actually engaging, as opposed to this file's
// "the whole consume() call failed outright" scenario.

function mockRes() {
  const res: Partial<Response> = {}
  res.status = vi.fn().mockReturnValue(res)
  res.json = vi.fn().mockReturnValue(res)
  res.set = vi.fn().mockReturnValue(res)
  return res as Response
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("rate limiters fail open on Redis/infra errors, not just quota breaches", () => {
  it("rateLimitAdminLogin calls next() when consume() rejects with a non-quota error", async () => {
    vi.spyOn(RateLimiterRedis.prototype, "consume").mockRejectedValueOnce(new Error("ECONNREFUSED"))
    const req = { ip: "1.2.3.4" } as Request
    const res = mockRes()
    const next = vi.fn()

    await rateLimitAdminLogin(req, res, next)

    expect(next).toHaveBeenCalledTimes(1)
    expect(res.status).not.toHaveBeenCalled()
  })

  it("rateLimitAdminLogin still returns 429 on a real quota breach", async () => {
    vi.spyOn(RateLimiterRedis.prototype, "consume").mockRejectedValueOnce({ msBeforeNext: 5000 })
    const req = { ip: "1.2.3.4" } as Request
    const res = mockRes()
    const next = vi.fn()

    await rateLimitAdminLogin(req, res, next)

    expect(next).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(429)
  })

  it("rateLimitAuthenticatedChat calls next() when consume() rejects with a non-quota error", async () => {
    vi.spyOn(RateLimiterRedis.prototype, "consume").mockRejectedValueOnce(new Error("ECONNREFUSED"))
    const token = signAccessToken("00000000-0000-0000-0000-000000000001")
    const req = { headers: { authorization: `Bearer ${token}` } } as unknown as Request
    const res = mockRes()
    const next = vi.fn()

    await rateLimitAuthenticatedChat(req, res, next)

    expect(next).toHaveBeenCalledTimes(1)
    expect(res.status).not.toHaveBeenCalled()
  })

  it("rateLimitAuthenticatedChat still returns 429 on a real quota breach", async () => {
    vi.spyOn(RateLimiterRedis.prototype, "consume").mockRejectedValueOnce({ msBeforeNext: 5000 })
    const token = signAccessToken("00000000-0000-0000-0000-000000000001")
    const req = { headers: { authorization: `Bearer ${token}` } } as unknown as Request
    const res = mockRes()
    const next = vi.fn()

    await rateLimitAuthenticatedChat(req, res, next)

    expect(next).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(429)
  })

  it("rateLimitPublicChat calls next() when consume() rejects with a non-quota error", async () => {
    vi.spyOn(RateLimiterRedis.prototype, "consume").mockRejectedValueOnce(new Error("ECONNREFUSED"))
    const req = { ip: "1.2.3.4", params: { chatbotId: "chatbot-1" } } as unknown as Request
    const res = mockRes()
    const next = vi.fn()

    await rateLimitPublicChat(req, res, next)

    expect(next).toHaveBeenCalledTimes(1)
    expect(res.status).not.toHaveBeenCalled()
  })

  it("rateLimitPublicChat still returns 429 on a real quota breach", async () => {
    vi.spyOn(RateLimiterRedis.prototype, "consume").mockRejectedValueOnce({ msBeforeNext: 5000 })
    const req = { ip: "1.2.3.4", params: { chatbotId: "chatbot-1" } } as unknown as Request
    const res = mockRes()
    const next = vi.fn()

    await rateLimitPublicChat(req, res, next)

    expect(next).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(429)
  })

  it("rateLimitPublicAttachment calls next() when consume() rejects with a non-quota error", async () => {
    vi.spyOn(RateLimiterRedis.prototype, "consume").mockRejectedValueOnce(new Error("ECONNREFUSED"))
    const req = { ip: "1.2.3.4", params: { chatbotId: "chatbot-1" } } as unknown as Request
    const res = mockRes()
    const next = vi.fn()

    await rateLimitPublicAttachment(req, res, next)

    expect(next).toHaveBeenCalledTimes(1)
    expect(res.status).not.toHaveBeenCalled()
  })

  it("rateLimitPublicAttachment still returns 429 on a real quota breach", async () => {
    vi.spyOn(RateLimiterRedis.prototype, "consume").mockRejectedValueOnce({ msBeforeNext: 5000 })
    const req = { ip: "1.2.3.4", params: { chatbotId: "chatbot-1" } } as unknown as Request
    const res = mockRes()
    const next = vi.fn()

    await rateLimitPublicAttachment(req, res, next)

    expect(next).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(429)
  })

  it.each([
    ["rateLimitOtpSend", rateLimitOtpSend],
    ["rateLimitOtpVerify", rateLimitOtpVerify],
    ["rateLimitPasswordForgot", rateLimitPasswordForgot],
    ["rateLimitLogin", rateLimitLogin],
  ] as const)("%s calls next() when consume() rejects with a non-quota error", async (_name, middleware) => {
    vi.spyOn(RateLimiterRedis.prototype, "consume").mockRejectedValueOnce(new Error("ECONNREFUSED"))
    const req = { ip: "1.2.3.4" } as Request
    const res = mockRes()
    const next = vi.fn()

    await middleware(req, res, next)

    expect(next).toHaveBeenCalledTimes(1)
    expect(res.status).not.toHaveBeenCalled()
  })

  it.each([
    ["rateLimitOtpSend", rateLimitOtpSend],
    ["rateLimitOtpVerify", rateLimitOtpVerify],
    ["rateLimitPasswordForgot", rateLimitPasswordForgot],
    ["rateLimitLogin", rateLimitLogin],
  ] as const)("%s still returns 429 on a real quota breach", async (_name, middleware) => {
    vi.spyOn(RateLimiterRedis.prototype, "consume").mockRejectedValueOnce({ msBeforeNext: 5000 })
    const req = { ip: "1.2.3.4" } as Request
    const res = mockRes()
    const next = vi.fn()

    await middleware(req, res, next)

    expect(next).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(429)
  })
})
