import type { Request, Response } from "express"
import { afterEach, describe, expect, it, vi } from "vitest"

import { captureLogs } from "../helpers/captureLogs.js"

// CS-10 / owner's "Test D" (unit half): synthetic CANARY secrets pushed
// through the real logger, error handler, e-mail sender and API boot code,
// asserting against the real final stdout/stderr output.

const CANARY = /CANARY/i

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.doUnmock("../../src/app.js")
  vi.doUnmock("../../src/lib/redis.js")
  vi.doUnmock("../../src/lib/db.js")
  vi.doUnmock("../../src/services/modelCosts.service.js")
  vi.resetModules()
})

function fakeRes() {
  const res: Partial<Response> & { statusCode?: number; body?: unknown } = {}
  res.status = vi.fn((code: number) => {
    res.statusCode = code
    return res as Response
  })
  res.json = vi.fn((body: unknown) => {
    res.body = body
    return res as Response
  })
  return res as Response & { statusCode: number; body: unknown }
}

describe("logger redaction", () => {
  it("redacts secret-named keys at the top level and nested, and allowlists req/res/err", async () => {
    const { baseLogger } = await import("../../src/lib/logger.js")
    const cap = captureLogs()
    try {
      baseLogger.info(
        {
          token: "CANARY-TOP-TOKEN",
          password: "CANARY-PW-top",
          apiKey: "CANARY-APIKEY",
          authorization: "CANARY-AUTH-top",
          cookie: "CANARY-CK-top",
          databaseUrl: "CANARY-DBURL",
          otp: "CANARY-OTP",
          nested: { deeper: { refreshToken: "CANARY-RT", secret: "CANARY-SECRET" } },
          req: {
            method: "POST",
            originalUrl: "/auth/login?token=CANARY-QUERY",
            id: "req-123",
            body: { password: "CANARY-PW-body" },
            headers: {
              cookie: "cm360_session=CANARY-CK-hdr",
              authorization: "Bearer CANARY-TOK-hdr",
              "x-api-key": "CANARY-XAPI",
              "user-agent": "vitest-agent",
            },
          },
          res: { statusCode: 401, headers: { "set-cookie": "s=CANARY-SETCK" } },
          durationMs: 12,
        },
        "request finished",
      )
      const err = Object.assign(new Error("upstream failed"), {
        config: { headers: { Authorization: "Bearer CANARY-TOK-axios" }, data: "CANARY-BODY" },
        response: { data: "CANARY-RESP" },
        code: "ECONNRESET",
      })
      baseLogger.error({ err }, "outbound call failed")
    } finally {
      cap.restore()
    }
    const out = cap.text()
    expect(out).not.toMatch(CANARY)
    // Still useful: route (no query), method, status, request id, duration, error category.
    expect(out).toContain('"route":"/auth/login"')
    expect(out).toContain('"method":"POST"')
    expect(out).toContain('"statusCode":401')
    expect(out).toContain('"requestId":"req-123"')
    expect(out).toContain('"durationMs":12')
    expect(out).toContain('"user-agent":"vitest-agent"')
    expect(out).toContain('"code":"ECONNRESET"')
    expect(out).toContain('"type":"Error"')
  })

  it("scrubs secret-shaped values in messages and unexpected keys (second layer)", async () => {
    const { baseLogger, scrubSecrets } = await import("../../src/lib/logger.js")
    const cap = captureLogs()
    try {
      baseLogger.warn(
        {
          detail: "auth Bearer CANARYTOKbearer123 failed",
          dsn: "postgresql://app:CANARYPG@db.internal:5432/chatmate",
          queue: "redis://:CANARYREDIS@cache:6379",
          openai: "sk-proj-CANARYOPENAI0123456789",
          stripe: "sk_live_CANARYSTRIPE123",
          webhook: "whsec_CANARYWHSEC12345",
          jwt: "eyJhbGciOiJIUzI1NiJ9.eyJDQU5BUlkiOiJ4In0.CANARYsig",
        },
        "connect postgres://u:CANARYPG2@h/db failed, password=CANARYPW3 token: CANARYTOK4",
      )
    } finally {
      cap.restore()
    }
    const out = cap.text()
    expect(out).not.toMatch(CANARY)
    expect(out).toContain("db.internal:5432/chatmate")
    expect(out).toContain("cache:6379")
    // Every scrubbed line is still valid JSON.
    for (const line of cap.lines()) expect(() => JSON.parse(line)).not.toThrow()
    expect(scrubSecrets("status code: 500")).toBe("status code: 500")
  })

  it("describeConnectionUrl keeps host/port/db and drops credentials", async () => {
    const { describeConnectionUrl } = await import("../../src/lib/logger.js")
    const described = describeConnectionUrl("rediss://default:CANARY-REDIS@cache.example:6380/2")
    expect(JSON.stringify(described)).not.toMatch(CANARY)
    expect(described).toEqual({ configured: true, scheme: "rediss", host: "cache.example", port: "6380", db: "2", credentials: "set" })
    expect(describeConnectionUrl("")).toEqual({ configured: false })
  })
})

describe("errorHandler — logs and responses", () => {
  it("never puts a secret from an unexpected error into logs or the response", async () => {
    const { errorHandler } = await import("../../src/middleware/errorHandler.js")
    const res = fakeRes()
    const cap = captureLogs()
    try {
      const err = Object.assign(new Error("connect postgres://app:CANARY-PG@10.0.0.5/db password=CANARY-PW-err"), {
        config: { headers: { Authorization: "Bearer CANARY-TOK-err" } },
      })
      errorHandler(err, { method: "GET", originalUrl: "/auth/me?token=CANARY-Q", headers: {} } as unknown as Request, res, vi.fn())
    } finally {
      cap.restore()
    }
    expect(res.statusCode).toBe(500)
    expect(res.body).toEqual({ ok: false, error: "Something went wrong" })
    const out = cap.text()
    expect(out).toContain("unhandled error")
    expect(out).toContain('"route":"/auth/me"')
    expect(out).not.toMatch(CANARY)
  })
})

describe("sendEmail without RESEND_API_KEY", () => {
  const otpEmail = {
    to: "otp-user@example.test",
    subject: "Your ChatMate360 verification code",
    text: "Your verification code is: 731946\n\nReset: https://frontend.test/auth/reset-password?token=CANARYRESETTOKEN0123456789abcdef",
    html: "<p>731946</p>",
  }

  it("non-production: logs the e-mail with codes and links redacted by default", async () => {
    vi.stubEnv("RESEND_API_KEY", "")
    vi.stubEnv("EMAIL_LOG_SHOW_SECRETS", "")
    const { sendEmail } = await import("../../src/lib/email.js")
    const cap = captureLogs()
    let result
    try {
      result = await sendEmail(otpEmail)
    } finally {
      cap.restore()
    }
    expect(result).toEqual({ delivered: false })
    const out = cap.text()
    expect(out).toContain("email not sent")
    expect(out).toContain("[code redacted]")
    expect(out).not.toContain("731946")
    expect(out).not.toMatch(CANARY)
    expect(out).not.toContain("reset-password")
  })

  it("non-production: EMAIL_LOG_SHOW_SECRETS=true opts in to seeing codes locally", async () => {
    vi.stubEnv("NODE_ENV", "development")
    vi.stubEnv("RESEND_API_KEY", "")
    vi.stubEnv("EMAIL_LOG_SHOW_SECRETS", "true")
    const { sendEmail } = await import("../../src/lib/email.js")
    const cap = captureLogs()
    try {
      await sendEmail({ ...otpEmail, text: "Your verification code is: 731946" })
    } finally {
      cap.restore()
    }
    expect(cap.text()).toContain("731946")
  })

  it("production (explicit opt-out): logs only recipient hash + subject, never the body or address, even with EMAIL_LOG_SHOW_SECRETS", async () => {
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("RESEND_API_KEY", "")
    vi.stubEnv("ALLOW_EMAIL_LOG_ONLY_IN_PRODUCTION", "true")
    vi.stubEnv("EMAIL_LOG_SHOW_SECRETS", "true")
    const { sendEmail } = await import("../../src/lib/email.js")
    const cap = captureLogs()
    try {
      await sendEmail(otpEmail)
    } finally {
      cap.restore()
    }
    const out = cap.text()
    expect(out).toContain("email not sent")
    expect(out).toContain("toRef")
    expect(out).not.toContain("731946")
    expect(out).not.toMatch(CANARY)
    expect(out).not.toContain("example.test")
  })

  it("with a key: the Resend call has a timeout and failures never log the key or body", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_CANARYKEY_CANARYKEY")
    const fetchMock = vi.fn(async () => new Response("bad request", { status: 422 }))
    vi.stubGlobal("fetch", fetchMock)
    const { sendEmail } = await import("../../src/lib/email.js")
    const cap = captureLogs()
    try {
      expect(await sendEmail(otpEmail)).toEqual({ delivered: false })
    } finally {
      cap.restore()
    }
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1]
    expect(init.signal).toBeInstanceOf(AbortSignal)
    const out = cap.text()
    expect(out).toContain("resend email failed")
    expect(out).not.toMatch(CANARY)
    expect(out).not.toContain("731946")
  })
})

describe("API boot log (src/index.ts)", () => {
  async function bootWith(ping: () => Promise<string>) {
    vi.stubEnv("REDIS_URL", "redis://default:CANARY-REDIS@127.0.0.1:6379/0")
    vi.doMock("../../src/app.js", () => ({
      app: { listen: (_port: number, cb?: () => void) => { cb?.(); return { close: (fn?: () => void) => fn?.() } } },
    }))
    vi.doMock("../../src/lib/redis.js", () => ({ redis: { ping, quit: async () => "OK" } }))
    vi.doMock("../../src/lib/db.js", () => ({ pool: null }))
    vi.doMock("../../src/services/modelCosts.service.js", () => ({ refreshModelCostCache: async () => undefined }))
    const before = { term: process.listeners("SIGTERM"), int: process.listeners("SIGINT") }
    const cap = captureLogs()
    try {
      await import("../../src/index.js")
      await new Promise((resolve) => setTimeout(resolve, 50))
    } finally {
      cap.restore()
      for (const l of process.listeners("SIGTERM")) if (!before.term.includes(l)) process.off("SIGTERM", l)
      for (const l of process.listeners("SIGINT")) if (!before.int.includes(l)) process.off("SIGINT", l)
    }
    return cap.text()
  }

  it("never logs the Redis password when Redis is reachable", async () => {
    const out = await bootWith(async () => "PONG")
    expect(out).toContain("redis reachable at boot")
    expect(out).toContain("127.0.0.1")
    expect(out).not.toMatch(CANARY)
  })

  it("never logs the Redis password when Redis is unreachable", async () => {
    const out = await bootWith(async () => {
      throw new Error("connect ECONNREFUSED")
    })
    expect(out).toContain("REDIS UNREACHABLE AT BOOT")
    expect(out).not.toMatch(CANARY)
  })
})
