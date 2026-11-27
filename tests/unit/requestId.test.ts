import type { NextFunction, Request, Response } from "express"
import { describe, expect, it } from "vitest"

import { currentClientRequestId, currentRequestId } from "../../src/lib/requestContext.js"
import { requestId, sanitizeClientRequestId } from "../../src/middleware/requestId.js"

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

// Runs the middleware with a fake req/res and captures what the rest of the
// request would see as its request id (the key usage.service.ts reserves AI
// cost under — finding VER-01).
function runMiddleware(headerValue: string | string[] | undefined) {
  const headers: Record<string, string> = {}
  const req = { headers: headerValue === undefined ? {} : { "x-request-id": headerValue } } as unknown as Request
  const res = { set: (name: string, value: string) => { headers[name.toLowerCase()] = value } } as unknown as Response
  let seen: { requestId?: string; clientRequestId?: string } = {}
  const next: NextFunction = () => {
    seen = { requestId: currentRequestId(), clientRequestId: currentClientRequestId() }
  }
  requestId(req, res, next)
  return { req, headers, seen }
}

describe("requestId middleware — the reservation key is never client-controlled (VER-01)", () => {
  it("ignores a client X-Request-Id for req.id and currentRequestId(), generating a server UUID instead", () => {
    const client = "replay-me-123"
    const { req, headers, seen } = runMiddleware(client)

    expect(seen.requestId).toMatch(UUID_RE)
    expect(seen.requestId).not.toBe(client)
    expect(seen.requestId).not.toContain(client)
    expect(req.id).toBe(seen.requestId)
    expect(headers["x-request-id"]).toBe(seen.requestId)

    // Kept only for log correlation, separately from the reservation key.
    expect(seen.clientRequestId).toBe(client)
    expect(headers["x-client-request-id"]).toBe(client)
  })

  it("two requests with the same client X-Request-Id get different server ids", () => {
    const a = runMiddleware("same-id")
    const b = runMiddleware("same-id")
    expect(a.seen.requestId).not.toBe(b.seen.requestId)
  })

  it("generates an id when no header is sent, with no client id recorded", () => {
    const { seen, headers } = runMiddleware(undefined)
    expect(seen.requestId).toMatch(UUID_RE)
    expect(seen.clientRequestId).toBeUndefined()
    expect(headers["x-client-request-id"]).toBeUndefined()
  })

  it("drops client ids that are too long or contain unsafe characters", () => {
    expect(sanitizeClientRequestId("a".repeat(128))).toBe("a".repeat(128))
    expect(sanitizeClientRequestId("a".repeat(129))).toBeUndefined()
    expect(sanitizeClientRequestId("bad id\nwith newline")).toBeUndefined()
    expect(sanitizeClientRequestId("<script>")).toBeUndefined()
    expect(sanitizeClientRequestId("")).toBeUndefined()
    expect(sanitizeClientRequestId(["a", "b"])).toBeUndefined()
    expect(sanitizeClientRequestId("  ok.id:1-2_3  ")).toBe("ok.id:1-2_3")

    const { seen } = runMiddleware("bad id\r\nx-injected: 1")
    expect(seen.clientRequestId).toBeUndefined()
    expect(seen.requestId).toMatch(UUID_RE)
  })
})
