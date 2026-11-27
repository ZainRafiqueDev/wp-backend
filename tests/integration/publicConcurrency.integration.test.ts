import express from "express"
import request from "supertest"
import { afterEach, describe, expect, it } from "vitest"

import { env } from "../../src/env.js"
import { redis } from "../../src/lib/redis.js"
import { limitPublicChatConcurrency } from "../../src/middleware/rateLimitPublic.js"

const originalMax = env.publicChatMaxConcurrentPerChatbot

afterEach(() => {
  env.publicChatMaxConcurrentPerChatbot = originalMax
})

describe("public chatbot concurrency backpressure", () => {
  it("atomically prunes an expired crash slot before admitting new work", async () => {
    env.publicChatMaxConcurrentPerChatbot = 1
    const chatbotId = crypto.randomUUID()
    const key = `public-chat-concurrency:${chatbotId}`
    await redis.zadd(key, Date.now() - 1_000, "expired-request-token")

    const app = express()
    app.post("/public/:chatbotId/chat", limitPublicChatConcurrency, (_req, res) => {
      res.status(200).json({ ok: true })
    })

    const response = await request(app).post(`/public/${chatbotId}/chat`)
    expect(response.status).toBe(200)
    await redis.del(key)
  })

  it("rejects excess work with Retry-After and releases the slot after completion", async () => {
    env.publicChatMaxConcurrentPerChatbot = 1
    const chatbotId = crypto.randomUUID()
    const key = `public-chat-concurrency:${chatbotId}`
    await redis.del(key)

    let releaseFirst!: () => void
    const firstMayFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let markStarted!: () => void
    const firstStarted = new Promise<void>((resolve) => {
      markStarted = resolve
    })

    const app = express()
    app.post("/public/:chatbotId/chat", limitPublicChatConcurrency, async (_req, res) => {
      markStarted()
      await firstMayFinish
      res.status(200).json({ ok: true })
    })

    const first = request(app).post(`/public/${chatbotId}/chat`).then((response) => response)
    await firstStarted

    const rejected = await request(app).post(`/public/${chatbotId}/chat`)
    expect(rejected.status).toBe(503)
    expect(rejected.headers["retry-after"]).toBe("2")
    expect(rejected.body.error).toContain("busy")

    releaseFirst()
    expect((await first).status).toBe(200)

    const afterRelease = await request(app).post(`/public/${chatbotId}/chat`)
    expect(afterRelease.status).toBe(200)
    await redis.del(key)
  })
})
