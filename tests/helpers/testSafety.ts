import dns from "node:dns"
import http from "node:http"
import https from "node:https"
import { syncBuiltinESMExports } from "node:module"
import net, { isIP } from "node:net"

// CS-17 (B09-001, B09-018, S2-011, B08-018): the test suite must never reach
// a real third-party service by default. Everything here is pure and
// importable so tests/unit/testSafety.test.ts can exercise it directly; the
// per-file wiring lives in tests/setup/testSafety.setup.ts.

/** Opt in to tests that call real AI providers (OpenAI/Anthropic/Gemini). */
export const LIVE_AI_FLAG = "RUN_LIVE_AI_TESTS"
/** Opt in to tests that call Stripe's test-mode API. Live (`sk_live_`) keys are refused regardless. */
export const LIVE_STRIPE_FLAG = "RUN_LIVE_STRIPE_TESTS"

export const AI_PROVIDER_HOSTS = ["api.openai.com", "api.anthropic.com", "generativelanguage.googleapis.com"]
export const STRIPE_HOSTS = ["api.stripe.com", "files.stripe.com"]

export function flagEnabled(env: NodeJS.ProcessEnv, flag: string): boolean {
  return env[flag] === "1" || env[flag] === "true"
}

export function isLoopbackHost(rawHost: string): boolean {
  const host = rawHost.trim().toLowerCase().replace(/^\[|\]$/g, "")
  if (host === "" || host === "localhost" || host.endsWith(".localhost")) return true
  if (host === "::1" || host === "0:0:0:0:0:0:0:1") return true
  const v4 = host.startsWith("::ffff:") ? host.slice(7) : host
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4)
}

export function allowedEgressHosts(env: NodeJS.ProcessEnv): string[] {
  return [
    ...(flagEnabled(env, LIVE_AI_FLAG) ? AI_PROVIDER_HOSTS : []),
    ...(flagEnabled(env, LIVE_STRIPE_FLAG) ? STRIPE_HOSTS : []),
  ]
}

export function isEgressAllowed(host: string, env: NodeJS.ProcessEnv): boolean {
  if (isLoopbackHost(host)) return true
  const normalized = host.trim().toLowerCase()
  return allowedEgressHosts(env).includes(normalized)
}

// Key shapes of real credentials. Values are never echoed back — only the
// variable name ends up in an error message.
const ALWAYS_REFUSED: { pattern: RegExp; label: string }[] = [
  { pattern: /^sk_live_/, label: "a live Stripe secret key" },
  { pattern: /^rk_live_/, label: "a live Stripe restricted key" },
]
const AI_KEY_SHAPES: { pattern: RegExp; label: string }[] = [
  { pattern: /^sk-ant-[A-Za-z0-9_-]{10,}/, label: "a real Anthropic key" },
  { pattern: /^sk-(proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}$/, label: "a real OpenAI key" },
  { pattern: /^AIza[0-9A-Za-z_-]{30,}$/, label: "a real Google/Gemini key" },
]
const STRIPE_TEST_SHAPES: { pattern: RegExp; label: string }[] = [
  { pattern: /^(sk|rk)_test_[A-Za-z0-9]{20,}$/, label: "a real Stripe test-mode key" },
]

function isSecretVarName(name: string): boolean {
  return /(_API_KEY|_SECRET_KEY|_SECRET|_TOKEN|_DSN|_KEY)$/.test(name)
}

/**
 * Returns one message per environment variable that holds a credential the
 * current opt-in flags do not allow. Empty array = safe to run.
 */
export function detectForbiddenSecrets(env: NodeJS.ProcessEnv): string[] {
  const liveAi = flagEnabled(env, LIVE_AI_FLAG)
  const liveStripe = flagEnabled(env, LIVE_STRIPE_FLAG)
  const problems: string[] = []
  for (const [name, raw] of Object.entries(env)) {
    if (!raw || !isSecretVarName(name)) continue
    const value = raw.trim()
    const refused = ALWAYS_REFUSED.find((s) => s.pattern.test(value))
    if (refused) {
      problems.push(`${name} holds ${refused.label}; live payment keys are never allowed under tests`)
      continue
    }
    if (!liveAi) {
      const ai = AI_KEY_SHAPES.find((s) => s.pattern.test(value))
      if (ai) problems.push(`${name} holds ${ai.label}; set ${LIVE_AI_FLAG}=1 to run live AI tests on purpose`)
    }
    if (!liveStripe) {
      const stripe = STRIPE_TEST_SHAPES.find((s) => s.pattern.test(value))
      if (stripe) problems.push(`${name} holds ${stripe.label}; set ${LIVE_STRIPE_FLAG}=1 to call Stripe test mode on purpose`)
    }
  }
  for (const [name, raw] of Object.entries(env)) {
    const value = raw?.trim()
    if (!value) continue
    // Credentials that no test needs from the environment: OAuth client
    // secrets, cloud access keys, object-storage keys, passwords. vitest.config
    // blanks the known ones; anything still set came from a developer's
    // shell or .env and must not reach the code under test.
    if (isStandingCredentialName(name)) {
      problems.push(`${name} is set; tests must not inherit this credential (blank it or set it inside the test)`)
      continue
    }
    const remote = remoteUrlWithCredentials(value)
    if (remote) problems.push(`${name} is a URL with embedded credentials for non-local host ${remote}`)
  }
  return problems
}

const STANDING_CREDENTIAL_NAMES = [
  /_CLIENT_SECRET$/,
  /_SECRET_ACCESS_KEY$/,
  /_ACCESS_KEY(_ID)?$/,
  /_SESSION_TOKEN$/,
  /^DOCUMENT_STORAGE_.*(KEY|SECRET|TOKEN|PASSWORD)$/,
  /_PASSWORD$/,
]
// Local test-database passwords are expected (they only reach loopback).
const ALLOWED_PASSWORD_NAMES = /^(PGPASSWORD|POSTGRES_PASSWORD|TEST_[A-Z0-9_]*PASSWORD|[A-Z0-9_]*_TEST_[A-Z0-9_]*PASSWORD)$/

export function isStandingCredentialName(name: string): boolean {
  if (ALLOWED_PASSWORD_NAMES.test(name)) return false
  return STANDING_CREDENTIAL_NAMES.some((pattern) => pattern.test(name))
}

/** The host, when `value` is a URL carrying a username/password for a non-loopback host. */
export function remoteUrlWithCredentials(value: string): string | null {
  if (!/^[a-z][a-z0-9+.-]*:\/\/[^/\s]*@/i.test(value)) return null
  try {
    const url = new URL(value)
    if (!url.username && !url.password) return null
    return isLoopbackHost(url.hostname) ? null : url.hostname
  } catch {
    return null
  }
}

/** Refuses DATABASE_URL / REDIS_URL (and their TEST_ overrides) that point anywhere but loopback. */
export function detectNonLocalDataStores(env: NodeJS.ProcessEnv): string[] {
  const problems: string[] = []
  for (const name of ["TEST_DATABASE_URL", "TEST_REDIS_URL", "DATABASE_URL", "REDIS_URL", "BOOKLY_TEST_DATABASE_URL"]) {
    const value = env[name]?.trim()
    if (!value) continue
    let host: string
    try {
      host = new URL(value).hostname
    } catch {
      problems.push(`${name} is not a valid URL`)
      continue
    }
    if (!isLoopbackHost(host)) problems.push(`${name} points at non-local host ${host}; tests only run against local Postgres/Redis`)
  }
  return problems
}

// ---------------------------------------------------------------------------
// Network egress guard. Violations are kept on globalThis so every module
// instance (setup file, test file) sees the same list.
//
// Layers, outermost first:
//   1. global fetch  -> non-retryable 403 (SDK retry loops would otherwise
//      back off for >30s on a thrown error);
//   2. node:http / node:https request/get -> throw (early, readable error);
//   3. net.Socket.prototype.connect -> the authoritative check. Every TCP/TLS
//      client in Node (net.connect, net.createConnection, tls.connect, the
//      bundled undici behind fetch, the npm `undici` package, pg, ioredis)
//      ends up here, so it checks the host Node will actually connect to,
//      whatever URL, options or agent a caller used;
//   4. dns lookup/resolve -> only localhost names (or a per-test stub).

const STATE_KEY = Symbol.for("cm360.testSafety.egress")

type GuardState = {
  installed: boolean
  violations: string[]
  dnsStub: Map<string, { address: string; family: 4 | 6 }[]>
}

function state(): GuardState {
  const g = globalThis as unknown as Record<symbol, GuardState | undefined>
  if (!g[STATE_KEY]) g[STATE_KEY] = { installed: false, violations: [], dnsStub: new Map() }
  return g[STATE_KEY] as GuardState
}

export class BlockedEgressError extends Error {
  code: string
  constructor(host: string, code = "ECONNREFUSED") {
    super(
      `CS-17 test egress guard: blocked a network call to "${host}". Tests must mock external services ` +
        `(set ${LIVE_AI_FLAG}=1 / ${LIVE_STRIPE_FLAG}=1 only for deliberate live runs).`,
    )
    this.name = "BlockedEgressError"
    this.code = code
  }
}

/**
 * Per-test opt-in for code that must resolve a public-looking hostname (SSRF
 * checks, crawler hostname handling). Answers come from this map, never from
 * real DNS. Connections are allowed only when every stubbed address is
 * loopback. Call clearTestDnsStub() in afterEach.
 */
export function setTestDnsStub(entries: Record<string, string | string[]>): void {
  const stub = state().dnsStub
  for (const [host, value] of Object.entries(entries)) {
    const addresses = (Array.isArray(value) ? value : [value]).map((address) => ({
      address,
      family: (isIP(address) === 6 ? 6 : 4) as 4 | 6,
    }))
    stub.set(host.toLowerCase(), addresses)
  }
}

export function clearTestDnsStub(): void {
  state().dnsStub.clear()
}

function hostOfFetchInput(input: unknown): string | null {
  try {
    if (typeof input === "string") return new URL(input).hostname
    if (input instanceof URL) return input.hostname
    if (input && typeof input === "object" && "url" in input) return new URL(String((input as { url: string }).url)).hostname
  } catch {
    return null
  }
  return null
}

type HttpTarget = { socketPath?: string; host: string }

function targetOfHttpArgs(args: unknown[]): HttpTarget {
  const [first, second] = args
  let urlHost: string | undefined
  if (typeof first === "string") {
    try {
      urlHost = new URL(first).hostname
    } catch {
      urlHost = first
    }
  } else if (first instanceof URL) {
    urlHost = first.hostname
  }
  const opts = ((first && typeof first === "object" && !(first instanceof URL) ? first : second) ?? {}) as {
    hostname?: string
    host?: string
    socketPath?: string
  }
  if (opts.socketPath) return { socketPath: opts.socketPath, host: "localhost" }
  // Options override the URL, exactly as http.request does.
  const raw = opts.hostname ?? (opts.host ? opts.host.replace(/:\d+$/, "") : undefined) ?? urlHost ?? "localhost"
  return { host: raw }
}

type ConnectTarget = { path?: string; host: string }

function targetOfConnectArgs(args: unknown[]): ConnectTarget {
  // net.connect() hands Socket#connect an internal [options, cb] array.
  const a = Array.isArray(args[0]) ? (args[0] as unknown[]) : args
  const first = a[0]
  if (first && typeof first === "object") {
    const opts = first as { path?: string; host?: string; hostname?: string }
    if (opts.path) return { path: opts.path, host: "localhost" }
    return { host: opts.host ?? opts.hostname ?? "localhost" }
  }
  if (typeof first === "string" && !/^\d+$/.test(first)) return { path: first, host: "localhost" }
  return { host: typeof a[1] === "string" ? a[1] : "localhost" }
}

function block(host: string, code?: string): BlockedEgressError {
  const s = state()
  const err = new BlockedEgressError(host, code)
  // First block per host: print where it came from, so the test that needs a
  // mock is easy to find even when the app code swallows the error.
  if (!s.violations.includes(host)) {
    const frames = (err.stack ?? "").split("\n").slice(1).filter((l) => !l.includes("testSafety")).slice(0, 12)
    console.warn(`[test-safety] blocked egress to ${host}\n${frames.join("\n")}`)
  }
  s.violations.push(host)
  return err
}

function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "")
}

/** May a TCP/TLS connection to `host` be opened? */
export function isConnectAllowed(host: string, env: NodeJS.ProcessEnv): boolean {
  const h = normalizeHost(host)
  if (isLoopbackHost(h)) return true
  if (isIP(h)) return false
  const stubbed = state().dnsStub.get(h)
  if (stubbed) return stubbed.length > 0 && stubbed.every((entry) => isLoopbackHost(entry.address))
  return allowedEgressHosts(env).includes(h)
}

type DnsDecision =
  | { kind: "real" }
  | { kind: "stub"; addresses: { address: string; family: 4 | 6 }[] }
  | { kind: "block" }

/** How a DNS query for `host` is answered. */
export function dnsDecision(host: string, env: NodeJS.ProcessEnv): DnsDecision {
  const h = normalizeHost(host)
  const stubbed = state().dnsStub.get(h)
  if (stubbed) return { kind: "stub", addresses: stubbed }
  // IP literals and localhost names never leave the machine.
  if (isIP(h) || isLoopbackHost(h)) return { kind: "real" }
  if (allowedEgressHosts(env).includes(h)) return { kind: "real" }
  return { kind: "block" }
}

type LookupOpts = { family?: number | string; all?: boolean }

function lookupOptions(options: unknown): LookupOpts {
  if (typeof options === "number") return { family: options }
  if (options && typeof options === "object") return options as LookupOpts
  return {}
}

function pickStub(addresses: { address: string; family: 4 | 6 }[], opts: LookupOpts) {
  const family = opts.family === "IPv4" ? 4 : opts.family === "IPv6" ? 6 : Number(opts.family || 0)
  return family === 4 || family === 6 ? addresses.filter((a) => a.family === family) : addresses
}

function installDnsGuard(env: NodeJS.ProcessEnv): void {
  const realLookup = dns.lookup
  const patchedLookup = function (this: unknown, hostname: string, options: unknown, callback?: unknown) {
    const cb = (typeof options === "function" ? options : callback) as (...a: unknown[]) => void
    const opts = typeof options === "function" ? {} : lookupOptions(options)
    const decision = dnsDecision(hostname, env)
    if (decision.kind === "real") return (realLookup as (...a: unknown[]) => unknown).call(dns, hostname, opts, cb)
    if (decision.kind === "stub") {
      const found = pickStub(decision.addresses, opts)
      process.nextTick(() => {
        if (found.length === 0) return cb(Object.assign(new Error(`stub: no records for ${hostname}`), { code: "ENOTFOUND" }))
        if (opts.all) return cb(null, found)
        cb(null, found[0].address, found[0].family)
      })
      return undefined
    }
    const err = block(hostname, "ENOTFOUND")
    process.nextTick(() => cb(err))
    return undefined
  }
  ;(dns as { lookup: unknown }).lookup = patchedLookup

  const promises = dns.promises as { lookup: unknown } & Record<string, unknown>
  const realPromiseLookup = dns.promises.lookup
  promises.lookup = async (hostname: string, options?: unknown) => {
    const opts = lookupOptions(options)
    const decision = dnsDecision(hostname, env)
    if (decision.kind === "real") return (realPromiseLookup as (...a: unknown[]) => unknown).call(dns.promises, hostname, opts)
    if (decision.kind === "stub") {
      const found = pickStub(decision.addresses, opts)
      if (found.length === 0) throw Object.assign(new Error(`stub: no records for ${hostname}`), { code: "ENOTFOUND" })
      return opts.all ? found : found[0]
    }
    throw block(hostname, "ENOTFOUND")
  }

  // Direct resolver queries (no stub support): only localhost / opted-in names.
  for (const name of ["resolve", "resolve4", "resolve6", "resolveAny", "resolveCname", "resolveTxt", "resolveMx", "resolveNs", "resolveSrv"] as const) {
    const realCb = (dns as unknown as Record<string, (...a: unknown[]) => unknown>)[name]
    ;(dns as unknown as Record<string, unknown>)[name] = function (hostname: string, ...rest: unknown[]) {
      if (dnsDecision(hostname, env).kind === "real") return realCb.call(dns, hostname, ...rest)
      const cb = rest[rest.length - 1] as (err: unknown) => void
      const err = block(hostname, "ENOTFOUND")
      process.nextTick(() => cb(err))
      return undefined
    }
    const realP = promises[name] as (...a: unknown[]) => unknown
    promises[name] = async (hostname: string, ...rest: unknown[]) => {
      if (dnsDecision(hostname, env).kind === "real") return realP.call(dns.promises, hostname, ...rest)
      throw block(hostname, "ENOTFOUND")
    }
  }
}

function installSocketGuard(env: NodeJS.ProcessEnv): void {
  const realConnect = net.Socket.prototype.connect
  net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
    const target = targetOfConnectArgs(args)
    if (!target.path && !isConnectAllowed(target.host, env)) {
      const err = block(normalizeHost(target.host))
      process.nextTick(() => this.destroy(err))
      return this
    }
    return (realConnect as (...a: unknown[]) => net.Socket).apply(this, args)
  } as typeof net.Socket.prototype.connect
}

export function installEgressGuard(env: NodeJS.ProcessEnv = process.env): void {
  const s = state()
  if (s.installed) return
  s.installed = true

  const realFetch = globalThis.fetch
  const guardedFetch: typeof fetch = async (input, init) => {
    const host = hostOfFetchInput(input)
    if (host !== null && !isConnectAllowed(host, env)) {
      // A non-retryable 403 rather than a thrown network error: SDK retry
      // loops (openai, LangChain p-retry) back off for >30s on connection
      // errors, which turned a blocked call into a test timeout. The call is
      // still recorded and fails the file in the setup's afterAll.
      const err = block(normalizeHost(host))
      return new Response(JSON.stringify({ error: { message: err.message, type: "blocked_by_test_egress_guard" } }), {
        status: 403,
        headers: { "content-type": "application/json", "x-cm360-egress-blocked": "1" },
      })
    }
    return realFetch(input, init)
  }
  ;(guardedFetch as unknown as { __cm360EgressGuard: true }).__cm360EgressGuard = true
  globalThis.fetch = guardedFetch

  for (const mod of [http, https] as const) {
    const realRequest = mod.request
    const realGet = mod.get
    const wrap = <T extends (...a: never[]) => http.ClientRequest>(real: T): T =>
      ((...args: unknown[]) => {
        const target = targetOfHttpArgs(args)
        if (!target.socketPath && !isConnectAllowed(target.host, env)) throw block(normalizeHost(target.host))
        return (real as unknown as (...a: unknown[]) => http.ClientRequest)(...args)
      }) as unknown as T
    ;(mod as { request: typeof http.request }).request = wrap(realRequest)
    ;(mod as { get: typeof http.get }).get = wrap(realGet)
  }

  installSocketGuard(env)
  installDnsGuard(env)
  syncBuiltinESMExports()
}

export function isEgressGuardInstalled(): boolean {
  return state().installed
}

/** Returns and clears the recorded violations (hosts). */
export function drainEgressViolations(): string[] {
  const s = state()
  const out = [...s.violations]
  s.violations.length = 0
  return out
}
