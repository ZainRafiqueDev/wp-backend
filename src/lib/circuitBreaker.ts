import { cacheRedis } from "./redis.js"
import { log } from "./logger.js"

export type CircuitState = "CLOSED" | "OPEN" | "HALF-OPEN"

export type CircuitSnapshot = {
  provider: string
  state: CircuitState
  failures: number
  successes: number
  lastFailureAt: string | null
  openedAt: string | null
}

const KEY_PREFIX = "circuit:"
const TTL_SECONDS = 5 * 60
const OPEN_FAILURES = 5
const OPEN_WINDOW_MS = 30_000
const RECOVERY_MS = 60_000
const HALF_OPEN_SUCCESSES = 3

type StoredCircuit = {
  state: CircuitState
  failures: number
  successes: number
  lastFailureAt: number | null
  openedAt: number | null
  windowStartedAt: number | null
}

const EMPTY: StoredCircuit = {
  state: "CLOSED",
  failures: 0,
  successes: 0,
  lastFailureAt: null,
  openedAt: null,
  windowStartedAt: null,
}

// Optional key namespace, read on every call. Unset in production (keys stay
// `circuit:<provider>`). The test setup sets a per-file value so circuit
// state tripped by one test file never changes routing in another (CS-17).
// Exported for tests only.
export function circuitKey(provider: string): string {
  const namespace = process.env.CIRCUIT_BREAKER_KEY_NAMESPACE?.trim()
  return namespace ? `${KEY_PREFIX}${namespace}:${provider}` : `${KEY_PREFIX}${provider}`
}
const key = circuitKey

async function load(provider: string): Promise<StoredCircuit> {
  try {
    const raw = await cacheRedis.get(key(provider))
    if (!raw) return { ...EMPTY }
    return { ...EMPTY, ...(JSON.parse(raw) as StoredCircuit) }
  } catch {
    return { ...EMPTY }
  }
}

async function save(provider: string, value: StoredCircuit): Promise<void> {
  try {
    await cacheRedis.set(key(provider), JSON.stringify(value), "EX", TTL_SECONDS)
  } catch (err) {
    log().warn(
      { event: "circuit.save_failed", provider, err: err instanceof Error ? err.message : String(err) },
      "circuit breaker redis write failed — fail-open",
    )
  }
}

function maybeRecover(current: StoredCircuit, now: number): StoredCircuit {
  if (current.state !== "OPEN" || current.openedAt == null) return current
  if (now - current.openedAt < RECOVERY_MS) return current
  return { ...current, state: "HALF-OPEN", successes: 0 }
}

export async function getCircuit(provider: string): Promise<CircuitSnapshot> {
  const stored = maybeRecover(await load(provider), Date.now())
  return {
    provider,
    state: stored.state,
    failures: stored.failures,
    successes: stored.successes,
    lastFailureAt: stored.lastFailureAt ? new Date(stored.lastFailureAt).toISOString() : null,
    openedAt: stored.openedAt ? new Date(stored.openedAt).toISOString() : null,
  }
}

export async function isCircuitOpen(provider: string): Promise<boolean> {
  const snap = await getCircuit(provider)
  return snap.state === "OPEN"
}

export async function recordCircuitSuccess(provider: string): Promise<CircuitSnapshot> {
  const now = Date.now()
  const current = maybeRecover(await load(provider), now)
  let next: StoredCircuit
  if (current.state === "HALF-OPEN") {
    const successes = current.successes + 1
    next =
      successes >= HALF_OPEN_SUCCESSES
        ? { ...EMPTY }
        : { ...current, successes, failures: 0 }
  } else {
    next = { ...current, failures: 0, windowStartedAt: null, successes: 0, state: "CLOSED" }
  }
  await save(provider, next)
  return getCircuit(provider)
}

export async function recordCircuitFailure(provider: string): Promise<CircuitSnapshot> {
  const now = Date.now()
  const current = maybeRecover(await load(provider), now)

  if (current.state === "HALF-OPEN") {
    const next: StoredCircuit = {
      state: "OPEN",
      failures: current.failures + 1,
      successes: 0,
      lastFailureAt: now,
      openedAt: now,
      windowStartedAt: now,
    }
    await save(provider, next)
    log().warn({ event: "circuit.opened", provider, metric: "circuit.opened" }, "provider circuit opened")
    return getCircuit(provider)
  }

  const windowStart = current.windowStartedAt && now - current.windowStartedAt <= OPEN_WINDOW_MS
    ? current.windowStartedAt
    : now
  const failures = windowStart === current.windowStartedAt ? current.failures + 1 : 1
  const opened = failures >= OPEN_FAILURES
  const next: StoredCircuit = {
    state: opened ? "OPEN" : "CLOSED",
    failures,
    successes: 0,
    lastFailureAt: now,
    openedAt: opened ? now : current.openedAt,
    windowStartedAt: windowStart,
  }
  await save(provider, next)
    if (opened) {
    log().warn({ event: "circuit.opened", provider, metric: "circuit.opened", failures }, "provider circuit opened")
    void import("../services/alerts.service.js").then((mod) => mod.maybeAlertCircuitOpen(provider)).catch(() => undefined)
  }
  return getCircuit(provider)
}

export async function listProviderCircuits(providers: string[]): Promise<CircuitSnapshot[]> {
  return Promise.all(providers.map((provider) => getCircuit(provider)))
}

const BACKOFF_MS = [1000, 2000, 4000, 8000]
const MAX_BACKOFF_MS = 30_000
const MAX_RETRIES = 3

export function providerBackoffMs(attempt: number): number {
  return Math.min(BACKOFF_MS[attempt] ?? MAX_BACKOFF_MS, MAX_BACKOFF_MS)
}

export function isProviderRateLimitError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false
  const status = "status" in err ? Number((err as { status?: number }).status) : NaN
  if (status === 429) return true
  const message = err instanceof Error ? err.message : String(err)
  return /\b429\b|rate.?limit/i.test(message)
}

export async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Retries a provider call on HTTP 429 with 1s/2s/4s/8s backoff (capped 30s).
 * After 3 retries the original error is rethrown. Non-429 errors throw immediately.
 */
export async function withProviderRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      if (!isProviderRateLimitError(err) || attempt === MAX_RETRIES) throw err
      await sleep(providerBackoffMs(attempt))
    }
  }
  throw lastErr
}
