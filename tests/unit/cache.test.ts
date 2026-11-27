import { randomUUID } from "node:crypto"

import { afterAll, describe, expect, it } from "vitest"

import {
  bumpChatbotCacheVersion,
  cacheKey,
  cacheSchemaTag,
  getCached,
  getChatbotCacheVersion,
  isTenantCacheKey,
  normalizeQuestionKey,
  setCached,
} from "../../src/lib/cache.js"
import { redis } from "../../src/lib/redis.js"

describe("cacheKey", () => {
  it("requires a chatbotId and always prefixes tenant", () => {
    expect(() => cacheKey("", "answer", "hash")).toThrow("cacheKey requires chatbotId")
    expect(() => cacheKey("   ", "pages")).toThrow("cacheKey requires chatbotId")

    const key = cacheKey("bot-a", "answer", "q1")
    expect(key).toBe(`tenant:bot-a:${cacheSchemaTag()}:answer:q1`)
    expect(isTenantCacheKey(key)).toBe(true)
    expect(cacheKey("bot-a", "answer", "q1")).not.toBe(cacheKey("bot-b", "answer", "q1"))
  })

  it("rejects keys that do not include a tenant prefix and schema version", () => {
    expect(isTenantCacheKey("answer:bot-a:q1")).toBe(false)
    expect(isTenantCacheKey("tenant:bot-a:answer:q1")).toBe(false)
    expect(isTenantCacheKey("tenant:")).toBe(false)
    expect(isTenantCacheKey("tenant:bot-a")).toBe(false)
    expect(isTenantCacheKey("tenant:bot-a:v1")).toBe(false)
  })
})

describe("normalizeQuestionKey", () => {
  it("produces the same key for questions differing only in case/whitespace", () => {
    expect(normalizeQuestionKey("Is it in stock?")).toBe(normalizeQuestionKey("  is it in stock?  "))
    expect(normalizeQuestionKey("is   it in   stock?")).toBe(normalizeQuestionKey("is it in stock?"))
  })

  it("produces different keys for genuinely different questions", () => {
    expect(normalizeQuestionKey("is it in stock?")).not.toBe(normalizeQuestionKey("what's the price?"))
  })
})

describe("getCached / setCached", () => {
  it("round-trips a JSON-serializable value under a tenant key", async () => {
    const key = cacheKey(`test-cache-${randomUUID()}`, "answer", "hello")
    await setCached(key, { text: "hello", aiGenerated: true }, 30)
    const value = await getCached<{ text: string; aiGenerated: boolean }>(key)
    expect(value).toEqual({ text: "hello", aiGenerated: true })
    await redis.del(key)
  })

  it("returns null on a genuine miss, distinct from a cached false/0/empty value", async () => {
    const chatbotId = `test-cache-${randomUUID()}`
    const missKey = cacheKey(chatbotId, "relevance", "miss")
    expect(await getCached(missKey)).toBeNull()

    const falseKey = cacheKey(chatbotId, "relevance", "false")
    await setCached(falseKey, false, 30)
    expect(await getCached(falseKey)).toBe(false)
    await redis.del(falseKey)
  })

  it("refuses to read or write a key that lacks a tenant prefix", async () => {
    const bare = `answer:unprefixed:${randomUUID()}`
    await setCached(bare, { leaked: true }, 30)
    expect(await redis.get(bare)).toBeNull()
    await redis.set(bare, JSON.stringify({ leaked: true }))
    expect(await getCached(bare)).toBeNull()
    await redis.del(bare)
  })
})

describe("chatbot cache version (invalidation)", () => {
  const chatbotId = `test-chatbot-${randomUUID()}`

  afterAll(async () => {
    await redis.del(cacheKey(chatbotId, "version"))
  })

  it("starts at 0 for a chatbot that's never had a version bump", async () => {
    expect(await getChatbotCacheVersion(chatbotId)).toBe(0)
  })

  it("increments on every bump, so a key built from the old version naturally misses after one", async () => {
    const before = await getChatbotCacheVersion(chatbotId)
    const key = cacheKey(chatbotId, "answer", `${before}:${normalizeQuestionKey("is it in stock?")}`)
    await setCached(key, { text: "yes, 12 left", aiGenerated: true }, 60)
    expect(await getCached(key)).not.toBeNull()

    await bumpChatbotCacheVersion(chatbotId)
    const after = await getChatbotCacheVersion(chatbotId)
    expect(after).toBe(before + 1)

    const newKey = cacheKey(chatbotId, "answer", `${after}:${normalizeQuestionKey("is it in stock?")}`)
    expect(await getCached(newKey)).toBeNull()

    await redis.del(key)
  })
})
