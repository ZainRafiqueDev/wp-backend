import { randomUUID } from "node:crypto"

import { config as loadDotenv } from "dotenv"
import { afterAll, vi } from "vitest"

import { detectForbiddenSecrets, detectNonLocalDataStores, drainEgressViolations, installEgressGuard } from "../helpers/testSafety.js"

// CS-17. Runs before every test file (vitest `setupFiles`).

// 1. Fail loudly on real credentials. src/env.ts loads .env with
//    dotenv's non-override semantics; loading it here first yields the exact
//    same process.env, so the check sees what the code under test will see.
loadDotenv({ quiet: true } as Parameters<typeof loadDotenv>[0])
// Also refuse a Postgres/Redis that is not on this machine: the suite writes
// to both, and a remote one would be someone else's data.
const forbidden = [...detectForbiddenSecrets(process.env), ...detectNonLocalDataStores(process.env)]
if (forbidden.length > 0) {
  throw new Error(`CS-17 test safety: refusing to run.\n- ${forbidden.join("\n- ")}`)
}

// 2. Block every non-loopback network call (fetch, node:http/https, every
//    net/tls socket, DNS lookups) unless explicitly opted in. Blocked calls are also recorded and fail the file
//    in afterAll, so a caller that swallows the error cannot hide it.
installEgressGuard(process.env)

// 2b. Embeddings are called on nearly every chat/retrieval path, so they get
//     a suite-wide deterministic fake (hashed bag-of-words vectors) instead of
//     the real OpenAI embeddings client. A test file's own
//     vi.mock("@langchain/openai") still takes precedence. Live runs
//     (RUN_LIVE_AI_TESTS=1) keep the real client.
vi.mock("@langchain/openai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@langchain/openai")>()
  const { flagEnabled, LIVE_AI_FLAG } = await import("../helpers/testSafety.js")
  if (flagEnabled(process.env, LIVE_AI_FLAG)) return actual
  const { FakeOpenAIEmbeddings } = await import("../helpers/fakeAi.js")
  return { ...actual, OpenAIEmbeddings: FakeOpenAIEmbeddings }
})

// 3. Per-file namespaces for shared Redis state. The local Redis is shared by
//    every test file (and other developers' runs); fixed keys made results
//    depend on what other files did:
//    - circuit-breaker keys (circuit:openai ...) tripped by one file changed
//      model routing in another (tests/unit/modelSelection.test.ts);
//    - the never-drained document-ingest queue grew past
//      DOCUMENT_INGEST_BACKPRESSURE_DEPTH (1000) and turned uploads into 429s
//      (asyncDocumentIngest "retries a failed document").
//    Queues created here are obliterated after the file; nothing else is
//    deleted.
const fileNamespace = `t${process.pid}-${randomUUID().slice(0, 8)}`
process.env.CIRCUIT_BREAKER_KEY_NAMESPACE = fileNamespace
const ownedQueues = {
  CRAWL_QUEUE_NAME: `crawl-queue-test-${fileNamespace}`,
  COMMERCE_QUEUE_NAME: `commerce-queue-test-${fileNamespace}`,
  DOCUMENT_INGEST_QUEUE_NAME: `document-ingest-test-${fileNamespace}`,
}
for (const [name, value] of Object.entries(ownedQueues)) process.env[name] = value

afterAll(async () => {
  await removeOwnedQueues(Object.values(ownedQueues))
  const violations = drainEgressViolations()
  if (violations.length > 0) {
    throw new Error(
      `CS-17 test egress guard: this file attempted ${violations.length} external network call(s) to ` +
        `${[...new Set(violations)].join(", ")}. Mock the service instead.`,
    )
  }
})

async function removeOwnedQueues(names: string[]): Promise<void> {
  const { default: IORedis } = await import("ioredis")
  const conn = new IORedis(process.env.REDIS_URL || "redis://127.0.0.1:6379", {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    connectTimeout: 2000,
    enableOfflineQueue: false,
  })
  try {
    await conn.connect()
    const { Queue } = await import("bullmq")
    for (const name of names) {
      const used = await conn.exists(`bull:${name}:id`, `bull:${name}:meta`, `bull:${name}:repeat`)
      if (!used) continue
      const queue = new Queue(name, { connection: conn })
      try {
        await queue.obliterate({ force: true })
      } finally {
        await queue.close().catch(() => {})
      }
    }
  } catch (err) {
    console.warn(`[test-safety] could not clean up test queues: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    conn.disconnect()
  }
}
