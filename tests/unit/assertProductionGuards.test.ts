import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// env.ts reads NODE_ENV/DOCUMENT_STORAGE_DRIVER/DOCUMENT_SCAN_VENDOR/
// ALLOW_UNSAFE_PROD_DEFAULTS at module-evaluation time, so each scenario
// below needs its own fresh import after stubbing — same pattern as
// tests/unit/ai.test.ts's provider-key stubbing, just per-test instead of
// once for the whole file, since this file deliberately varies NODE_ENV
// across its own cases.
async function freshEnv() {
  vi.resetModules()
  return await import("../../src/env.js")
}

describe("assertProductionGuards — unsafe production defaults must not boot silently", () => {
  // CS-10 added a RESEND_API_KEY guard; these storage/scanner scenarios
  // configure e-mail properly so each one still isolates its own guard.
  beforeEach(() => {
    vi.stubEnv("RESEND_API_KEY", "re_dummy_not_a_real_key")
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it("throws when NODE_ENV=production and DOCUMENT_STORAGE_DRIVER is left at the fs default", async () => {
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("DOCUMENT_STORAGE_DRIVER", "fs")
    vi.stubEnv("DOCUMENT_SCAN_VENDOR", "clamav")
    vi.stubEnv("ALLOW_UNSAFE_PROD_DEFAULTS", "")
    const { assertProductionGuards } = await freshEnv()
    expect(() => assertProductionGuards()).toThrow(/DOCUMENT_STORAGE_DRIVER=fs/)
  })

  it("throws when NODE_ENV=production and DOCUMENT_SCAN_VENDOR is left at the mock default", async () => {
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("DOCUMENT_STORAGE_DRIVER", "s3")
    vi.stubEnv("DOCUMENT_STORAGE_BUCKET", "test-bucket")
    vi.stubEnv("DOCUMENT_SCAN_VENDOR", "mock")
    vi.stubEnv("ALLOW_UNSAFE_PROD_DEFAULTS", "")
    const { assertProductionGuards } = await freshEnv()
    expect(() => assertProductionGuards()).toThrow(/DOCUMENT_SCAN_VENDOR=mock/)
  })

  it("does not throw in production once both are configured safely", async () => {
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("DOCUMENT_STORAGE_DRIVER", "s3")
    vi.stubEnv("DOCUMENT_STORAGE_BUCKET", "test-bucket")
    vi.stubEnv("DOCUMENT_SCAN_VENDOR", "clamav")
    vi.stubEnv("ALLOW_UNSAFE_PROD_DEFAULTS", "")
    const { assertProductionGuards } = await freshEnv()
    expect(() => assertProductionGuards()).not.toThrow()
  })

  it("allows local-disk storage in production when ALLOW_UNSAFE_PROD_DEFAULTS=true", async () => {
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("DOCUMENT_STORAGE_DRIVER", "fs")
    vi.stubEnv("DOCUMENT_SCAN_VENDOR", "clamav")
    vi.stubEnv("ALLOW_UNSAFE_PROD_DEFAULTS", "true")
    const { assertProductionGuards } = await freshEnv()
    expect(() => assertProductionGuards()).not.toThrow()
  })

  it("ALLOW_UNSAFE_PROD_DEFAULTS=true does NOT allow the mock malware scanner in production", async () => {
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("DOCUMENT_STORAGE_DRIVER", "fs")
    vi.stubEnv("DOCUMENT_SCAN_VENDOR", "mock")
    vi.stubEnv("ALLOW_UNSAFE_PROD_DEFAULTS", "true")
    vi.stubEnv("ALLOW_MOCK_MALWARE_SCAN_IN_PRODUCTION", "")
    const { assertProductionGuards } = await freshEnv()
    expect(() => assertProductionGuards()).toThrow(/DOCUMENT_SCAN_VENDOR=mock/)
  })

  it("allows the mock scanner in production only with its dedicated ALLOW_MOCK_MALWARE_SCAN_IN_PRODUCTION flag", async () => {
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("DOCUMENT_STORAGE_DRIVER", "s3")
    vi.stubEnv("DOCUMENT_STORAGE_BUCKET", "test-bucket")
    vi.stubEnv("DOCUMENT_SCAN_VENDOR", "mock")
    vi.stubEnv("ALLOW_MOCK_MALWARE_SCAN_IN_PRODUCTION", "true")
    const { assertProductionGuards } = await freshEnv()
    expect(() => assertProductionGuards()).not.toThrow()
  })

  it("does not throw outside production even with both unsafe defaults", async () => {
    vi.stubEnv("NODE_ENV", "development")
    vi.stubEnv("DOCUMENT_STORAGE_DRIVER", "fs")
    vi.stubEnv("DOCUMENT_SCAN_VENDOR", "mock")
    vi.stubEnv("ALLOW_UNSAFE_PROD_DEFAULTS", "")
    const { assertProductionGuards } = await freshEnv()
    expect(() => assertProductionGuards()).not.toThrow()
  })

  it("still throws on DOCUMENT_SCAN_SKIP=true in production regardless of ALLOW_UNSAFE_PROD_DEFAULTS", async () => {
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("DOCUMENT_STORAGE_DRIVER", "s3")
    vi.stubEnv("DOCUMENT_STORAGE_BUCKET", "test-bucket")
    vi.stubEnv("DOCUMENT_SCAN_VENDOR", "clamav")
    vi.stubEnv("DOCUMENT_SCAN_SKIP", "true")
    vi.stubEnv("ALLOW_UNSAFE_PROD_DEFAULTS", "true")
    const { assertProductionGuards } = await freshEnv()
    expect(() => assertProductionGuards()).toThrow(/DOCUMENT_SCAN_SKIP/)
  })
})

describe("assertProductionGuards — RESEND_API_KEY (CS-10, B03-015)", () => {
  function safeProductionStorage() {
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("DOCUMENT_STORAGE_DRIVER", "s3")
    vi.stubEnv("DOCUMENT_STORAGE_BUCKET", "test-bucket")
    vi.stubEnv("DOCUMENT_SCAN_VENDOR", "clamav")
    vi.stubEnv("DOCUMENT_SCAN_SKIP", "false")
    vi.stubEnv("ALLOW_UNSAFE_PROD_DEFAULTS", "")
  }

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it("refuses to boot in production without RESEND_API_KEY", async () => {
    safeProductionStorage()
    vi.stubEnv("RESEND_API_KEY", "")
    vi.stubEnv("ALLOW_EMAIL_LOG_ONLY_IN_PRODUCTION", "")
    const { assertProductionGuards } = await freshEnv()
    expect(() => assertProductionGuards()).toThrow(/RESEND_API_KEY/)
  })

  it("boots in production without RESEND_API_KEY only with the explicit ALLOW_EMAIL_LOG_ONLY_IN_PRODUCTION opt-out", async () => {
    safeProductionStorage()
    vi.stubEnv("RESEND_API_KEY", "")
    vi.stubEnv("ALLOW_EMAIL_LOG_ONLY_IN_PRODUCTION", "true")
    const { assertProductionGuards } = await freshEnv()
    expect(() => assertProductionGuards()).not.toThrow()
  })

  it("ALLOW_UNSAFE_PROD_DEFAULTS does not cover a missing RESEND_API_KEY", async () => {
    safeProductionStorage()
    vi.stubEnv("ALLOW_UNSAFE_PROD_DEFAULTS", "true")
    vi.stubEnv("RESEND_API_KEY", "")
    vi.stubEnv("ALLOW_EMAIL_LOG_ONLY_IN_PRODUCTION", "")
    const { assertProductionGuards } = await freshEnv()
    expect(() => assertProductionGuards()).toThrow(/RESEND_API_KEY/)
  })

  it("does not require RESEND_API_KEY outside production", async () => {
    vi.stubEnv("NODE_ENV", "development")
    vi.stubEnv("RESEND_API_KEY", "")
    const { assertProductionGuards } = await freshEnv()
    expect(() => assertProductionGuards()).not.toThrow()
  })
})
