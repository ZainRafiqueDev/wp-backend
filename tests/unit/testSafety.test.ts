import { afterEach, describe, expect, it } from "vitest"

import { circuitKey } from "../../src/lib/circuitBreaker.js"
import { booklyChildEnv, liveBooklyGate, LiveBooklyConfigError, startLiveBookly } from "../helpers/liveBookly.js"
import dns from "node:dns"
import net from "node:net"

import {
  BlockedEgressError,
  clearTestDnsStub,
  detectForbiddenSecrets,
  detectNonLocalDataStores,
  drainEgressViolations,
  isConnectAllowed,
  isEgressAllowed,
  isEgressGuardInstalled,
  isStandingCredentialName,
  remoteUrlWithCredentials,
  setTestDnsStub,
} from "../helpers/testSafety.js"

// CS-17 regression tests: test-suite safety rails (B09-001, B09-018, S2-011,
// B08-013, B08-018, B08-023) and shared-Redis isolation.

describe("CS-17 test env never carries real provider / Stripe credentials by default", () => {
  it("AI provider keys are the fake test values unless RUN_LIVE_AI_TESTS is set", () => {
    if (process.env.RUN_LIVE_AI_TESTS === "1") return
    expect(process.env.OPENAI_API_KEY).toBe("test-openai-key-not-real")
    expect(process.env.ANTHROPIC_API_KEY).toBe("test-anthropic-key-not-real")
    expect(process.env.GEMINI_API_KEY).toBe("test-gemini-key-not-real")
  })

  it("Stripe keys and Sentry DSN are blank unless RUN_LIVE_STRIPE_TESTS is set", () => {
    if (process.env.RUN_LIVE_STRIPE_TESTS !== "1") {
      expect(process.env.STRIPE_SECRET_KEY ?? "").toBe("")
      expect(process.env.STRIPE_WEBHOOK_SECRET ?? "").toBe("")
    }
    expect(process.env.SENTRY_DSN ?? "").toBe("")
  })

  it("detects real key shapes without the opt-in flag, and never echoes the value", () => {
    const fakeOpenAi = `sk-proj-${"a".repeat(40)}`
    const problems = detectForbiddenSecrets({ OPENAI_API_KEY: fakeOpenAi, ANTHROPIC_API_KEY: `sk-ant-api03-${"b".repeat(30)}` })
    expect(problems).toHaveLength(2)
    expect(problems.join("\n")).not.toContain(fakeOpenAi)
    expect(detectForbiddenSecrets({ OPENAI_API_KEY: fakeOpenAi, RUN_LIVE_AI_TESTS: "1" })).toEqual([])
  })

  it("refuses a live Stripe key even when Stripe tests are opted in", () => {
    expect(detectForbiddenSecrets({ STRIPE_SECRET_KEY: `sk_live_${"c".repeat(24)}`, RUN_LIVE_STRIPE_TESTS: "1" })).toHaveLength(1)
    expect(detectForbiddenSecrets({ STRIPE_SECRET_KEY: `sk_test_${"c".repeat(24)}` })).toHaveLength(1)
    expect(detectForbiddenSecrets({ STRIPE_SECRET_KEY: `sk_test_${"c".repeat(24)}`, RUN_LIVE_STRIPE_TESTS: "1" })).toEqual([])
  })

  it("the fake values configured for this run pass the check", () => {
    expect(detectForbiddenSecrets(process.env)).toEqual([])
    expect(detectNonLocalDataStores(process.env)).toEqual([])
  })

  it("flags standing credentials (OAuth secrets, cloud/storage keys, passwords) whatever their value", () => {
    for (const name of [
      "GOOGLE_CLIENT_SECRET",
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_SESSION_TOKEN",
      "DOCUMENT_STORAGE_ACCESS_KEY",
      "DOCUMENT_STORAGE_SECRET_KEY",
      "SMTP_PASSWORD",
    ]) {
      expect(isStandingCredentialName(name), name).toBe(true)
      expect(detectForbiddenSecrets({ [name]: "anything" }), name).toHaveLength(1)
    }
    expect(detectForbiddenSecrets({ GOOGLE_CLIENT_SECRET: "" })).toEqual([])
    for (const name of ["PGPASSWORD", "POSTGRES_PASSWORD", "TEST_DB_PASSWORD", "ACCESS_TOKEN_TTL_SECONDS", "PASSWORD_RESET_TTL_MINUTES"]) {
      expect(isStandingCredentialName(name), name).toBe(false)
    }
  })

  it("flags URLs with embedded credentials for non-local hosts only", () => {
    expect(remoteUrlWithCredentials("postgresql://u:p@db.example.com:5432/x")).toBe("db.example.com")
    expect(remoteUrlWithCredentials("redis://:secret@10.0.0.5:6379")).toBe("10.0.0.5")
    expect(remoteUrlWithCredentials("postgresql://u:p@127.0.0.1:5435/x")).toBeNull()
    expect(remoteUrlWithCredentials("https://api.example.com/x")).toBeNull()
    expect(detectForbiddenSecrets({ SOME_URL: "https://user:pw@hooks.example.com/x" })).toHaveLength(1)
  })

  it("refuses a non-local test database or Redis", () => {
    expect(detectNonLocalDataStores({ TEST_DATABASE_URL: "postgresql://a:b@db.example.com/x" })).toHaveLength(1)
    expect(detectNonLocalDataStores({ TEST_REDIS_URL: "redis://cache.internal:6379" })).toHaveLength(1)
    expect(detectNonLocalDataStores({ DATABASE_URL: "postgresql://a:b@127.0.0.1:5435/x", REDIS_URL: "redis://localhost:6379" })).toEqual([])
  })
})

describe("CS-17 network egress guard", () => {
  it("is installed for every test file", () => {
    expect(isEgressGuardInstalled()).toBe(true)
  })

  it("allows loopback only, unless a live flag opts a provider host in", () => {
    expect(isEgressAllowed("127.0.0.1", {})).toBe(true)
    expect(isEgressAllowed("localhost", {})).toBe(true)
    expect(isEgressAllowed("[::1]", {})).toBe(true)
    expect(isEgressAllowed("api.openai.com", {})).toBe(false)
    expect(isEgressAllowed("api.stripe.com", {})).toBe(false)
    expect(isEgressAllowed("api.openai.com", { RUN_LIVE_AI_TESTS: "1" })).toBe(true)
    expect(isEgressAllowed("api.stripe.com", { RUN_LIVE_AI_TESTS: "1" })).toBe(false)
    expect(isEgressAllowed("example.com", { RUN_LIVE_AI_TESTS: "1", RUN_LIVE_STRIPE_TESTS: "1" })).toBe(false)
  })

  it("blocks fetch (non-retryable 403) and https.request (throws) to a real provider before any socket is opened", async () => {
    if (process.env.RUN_LIVE_AI_TESTS === "1") return
    const res = await fetch("https://api.openai.com/v1/models")
    expect(res.status).toBe(403)
    expect(res.headers.get("x-cm360-egress-blocked")).toBe("1")
    const https = await import("node:https")
    expect(() => https.request("https://api.anthropic.com/v1/messages")).toThrow(BlockedEgressError)
    // These two were deliberate; clear them so this file's afterAll check passes.
    expect(drainEgressViolations()).toEqual(["api.openai.com", "api.anthropic.com"])
  })

  it("checks the host Node really connects to: options win over the URL; unix sockets are local", async () => {
    const https = await import("node:https")
    expect(() => https.request("https://localhost/x", { hostname: "198.51.100.20" })).toThrow(BlockedEgressError)
    expect(drainEgressViolations()).toEqual(["198.51.100.20"])
    expect(isConnectAllowed("::ffff:127.0.0.1", {})).toBe(true)
    expect(isConnectAllowed("10.0.0.1", {})).toBe(false)
  })

  it("blocks a raw socket to a remote address (the layer under fetch, http, tls and undici)", async () => {
    const err = await new Promise<Error>((resolve) => net.connect({ host: "198.51.100.21", port: 80 }).once("error", resolve))
    expect(err).toBeInstanceOf(BlockedEgressError)
    expect(drainEgressViolations()).toEqual(["198.51.100.21"])
  })

  describe("DNS", () => {
    afterEach(() => clearTestDnsStub())

    it("resolves localhost names but blocks (and records) any other lookup", async () => {
      await expect(dns.promises.lookup("localhost")).resolves.toBeDefined()
      await expect(dns.promises.lookup("blocked.invalid")).rejects.toBeInstanceOf(BlockedEgressError)
      expect(drainEgressViolations()).toEqual(["blocked.invalid"])
    })

    it("answers from a per-test stub without real DNS, and only allows connecting when the stub is loopback", async () => {
      setTestDnsStub({ "shop.example.com": "93.184.216.34", "rebind.example.com": "127.0.0.1" })
      await expect(dns.promises.lookup("shop.example.com")).resolves.toEqual({ address: "93.184.216.34", family: 4 })
      const viaCallback = await new Promise((resolve) =>
        dns.lookup("shop.example.com", { all: true }, (_e, addresses) => resolve(addresses)),
      )
      expect(viaCallback).toEqual([{ address: "93.184.216.34", family: 4 }])
      expect(isConnectAllowed("shop.example.com", {})).toBe(false)
      expect(isConnectAllowed("rebind.example.com", {})).toBe(true)
      expect(drainEgressViolations()).toEqual([])
    })
  })
})

describe("CS-17 live Bookly helper", () => {
  it("is disabled unless RUN_LIVE_BOOKLY_TESTS=1, even if a directory is configured", () => {
    const gate = liveBooklyGate({ BOOKLY_REPO_DIR: "C:\\somewhere" })
    expect(gate.enabled).toBe(false)
  })

  it("refuses to start (no child process) when disabled", async () => {
    await expect(startLiveBookly(4999, "unit", { enabled: false, reason: "off" })).rejects.toThrow(/refusing to start live Bookly/)
  })

  it("fails loudly (not a skip) when enabled but the repo is not pinned", () => {
    expect(() => liveBooklyGate({ RUN_LIVE_BOOKLY_TESTS: "1" })).toThrow(LiveBooklyConfigError)
    expect(() => liveBooklyGate({ RUN_LIVE_BOOKLY_TESTS: "1", BOOKLY_REPO_DIR: "relative/backend" })).toThrow(LiveBooklyConfigError)
  })

  it("passes the child process an allowlisted env with no secrets", () => {
    const parent: NodeJS.ProcessEnv = {
      PATH: "/usr/bin",
      OPENAI_API_KEY: "x",
      ANTHROPIC_API_KEY: "x",
      STRIPE_SECRET_KEY: "x",
      DATABASE_URL: "postgres://chatmate",
      JWT_SECRET: "parent-secret",
      INTEGRATION_ENCRYPTION_KEY: "x",
    }
    const child = booklyChildEnv({ DATABASE_URL: "postgres://bookly", PORT: "4091", JWT_SECRET: "test-jwt-secret", NODE_ENV: "test" }, parent)
    expect(child).toEqual({ PATH: "/usr/bin", DATABASE_URL: "postgres://bookly", PORT: "4091", JWT_SECRET: "test-jwt-secret", NODE_ENV: "test" })
    expect(Object.keys(child).filter((k) => /_API_KEY$|STRIPE|ENCRYPTION/.test(k))).toEqual([])
  })
})

describe("CS-17 circuit-breaker keys are namespaced per test file", () => {
  it("uses the per-file namespace so one file's tripped circuit never affects another", () => {
    const ns = process.env.CIRCUIT_BREAKER_KEY_NAMESPACE
    expect(ns).toBeTruthy()
    expect(circuitKey("openai")).toBe(`circuit:${ns}:openai`)
  })

  it("keeps the production key format when no namespace is set", () => {
    const saved = process.env.CIRCUIT_BREAKER_KEY_NAMESPACE
    delete process.env.CIRCUIT_BREAKER_KEY_NAMESPACE
    try {
      expect(circuitKey("openai")).toBe("circuit:openai")
    } finally {
      process.env.CIRCUIT_BREAKER_KEY_NAMESPACE = saved
    }
  })
})
