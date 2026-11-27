import { Redis as IORedis } from "ioredis"

import { env } from "../env.js"

// Two separate connections to the same Redis, not two Redis instances —
// this is the "DB-numbered namespaces as a cheap first step" split the
// 2026-09-29 production-hardening audit called for, done as two logical
// clients rather than two `db` numbers so each can carry the retry policy
// its own workload actually needs, without a migration step for existing
// deployed data.
//
// `redis` (queues): BullMQ's blocking commands (BRPOPLPUSH etc.) require
// `maxRetriesPerRequest: null` — a command issued while Redis is
// unreachable queues forever rather than rejecting. Keep this on its own
// connection, used ONLY for BullMQ `connection:` options
// (queue.ts/commerceQueue.ts/ingestQueue.ts), so that constraint stays
// scoped to the one workload that actually needs it.
//
// `cacheRedis` (everything else — answer/relevance cache, rate limiters,
// circuit breakers, metrics counters, the credit-reservation Lua scripts):
// a bounded `maxRetriesPerRequest` so a command fails fast and rejects when
// Redis is unreachable, instead of hanging indefinitely. This is exactly
// the shape of today's real incident (a dead Redis port silently hanging
// nearly every request) — usage.service.ts already had to hand-roll a
// `withRedisTimeout` `Promise.race` wrapper around every one of its own
// Redis calls specifically because it shared the BullMQ-constrained client;
// every other consumer below had no equivalent protection at all. Giving
// them their own connection with real retry bounds fixes that systemically
// instead of requiring the same wrapper copy-pasted into every call site.
export const redis = new IORedis(env.redisUrl, { maxRetriesPerRequest: null })

export const cacheRedis = new IORedis(env.redisUrl, { maxRetriesPerRequest: 2 })
