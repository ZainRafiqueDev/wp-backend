import { createHash } from "node:crypto"

import { env } from "../env.js"
import { cacheRedis } from "./redis.js"
import { log } from "./logger.js"

export type CacheKind = "answer" | "relevance" | "pages" | "backend-link" | "version"

export type CacheMetricName =
  | "cache.answer_hit"
  | "cache.answer_miss"
  | "cache.answer_read"
  | "cache.answer_write"
  | "cache.answer_bypass_tools"
  | "cache.answer_invalidate"

export function cacheSchemaTag(version = env.cacheSchemaVersion): string {
  return `v${version}`
}

export function cacheKey(chatbotId: string, kind: CacheKind, hash = ""): string {
  const tenant = chatbotId.trim()
  if (!tenant) {
    throw new Error("cacheKey requires chatbotId")
  }
  const schema = cacheSchemaTag()
  return hash ? `tenant:${tenant}:${schema}:${kind}:${hash}` : `tenant:${tenant}:${schema}:${kind}`
}

export function isTenantCacheKey(key: string): boolean {
  const parts = key.split(":")
  return parts[0] === "tenant" && Boolean(parts[1]) && /^v\d+$/.test(parts[2] ?? "") && Boolean(parts[3])
}

export async function incrementCacheMetric(
  name: CacheMetricName,
  fields: Record<string, unknown> = {},
): Promise<void> {
  log().info({ event: name, metric: name, ...fields }, name)
  try {
    const day = new Date().toISOString().slice(0, 10)
    const metricKey = `metric:${name}:${day}`
    await cacheRedis.incr(metricKey)
    await cacheRedis.expire(metricKey, 3 * 24 * 60 * 60)
  } catch {
    // Metrics must never take the answering path down.
  }
}

export async function getCached<T>(key: string): Promise<T | null> {
  if (!isTenantCacheKey(key)) {
    log().warn({ cacheKey: key, cacheEvent: "rejected" }, "cache read skipped — key is missing tenant prefix")
    return null
  }
  try {
    const raw = await cacheRedis.get(key)
    if (raw === null) {
      log().debug({ cacheKey: key, cacheEvent: "miss" }, "cache miss")
      return null
    }
    log().debug({ cacheKey: key, cacheEvent: "hit" }, "cache hit")
    return JSON.parse(raw) as T
  } catch (err) {
    log().warn({ cacheKey: key, err: err instanceof Error ? err.message : err }, "cache read failed, treating as miss")
    return null
  }
}

export async function setCached<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
  if (!isTenantCacheKey(key)) {
    log().warn({ cacheKey: key, cacheEvent: "rejected" }, "cache write skipped — key is missing tenant prefix")
    return
  }
  try {
    await cacheRedis.set(key, JSON.stringify(value), "EX", Math.max(1, Math.floor(ttlSeconds)))
  } catch (err) {
    log().warn({ cacheKey: key, err: err instanceof Error ? err.message : err }, "cache write failed, continuing without caching")
  }
}

export async function getChatbotCacheVersion(chatbotId: string): Promise<number> {
  try {
    const raw = await cacheRedis.get(cacheKey(chatbotId, "version"))
    return raw ? Number(raw) || 0 : 0
  } catch (err) {
    log().warn({ chatbotId, err: err instanceof Error ? err.message : err }, "cache version read failed, defaulting to 0")
    return 0
  }
}

export async function bumpChatbotCacheVersion(chatbotId: string): Promise<void> {
  try {
    await cacheRedis.incr(cacheKey(chatbotId, "version"))
    await incrementCacheMetric("cache.answer_invalidate", { chatbotId })
  } catch (err) {
    log().warn({ chatbotId, err: err instanceof Error ? err.message : err }, "cache version bump failed")
  }
}

export function normalizeQuestionKey(question: string): string {
  const normalized = question.trim().toLowerCase().replace(/\s+/g, " ")
  return createHash("sha256").update(normalized).digest("hex")
}
