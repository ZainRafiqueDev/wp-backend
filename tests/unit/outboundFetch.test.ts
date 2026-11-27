import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

// The real dispatcher is exercised against a local HTTP server. A hostname
// that "resolves" to 127.0.0.1 is how DNS rebinding looks from the socket's
// point of view, so dns.lookup is stubbed to return loopback for
// rebind.test and a public-looking address for public.test (the pre-check
// in assertSafeUrl uses dns/promises, which is mocked separately to always
// pass, simulating the first, benign answer of a rebinding record).
vi.mock("node:dns/promises", () => ({
  default: { lookup: async () => [{ address: "93.184.216.34", family: 4 }] },
}))

const { outboundFetch } = await import("../../src/lib/outboundFetch.js")
const { SsrfBlockedError, allowLiteralLoopbackForTests } = await import("../../src/lib/crawler/ssrf.js")

let server: Server
let port: number

beforeAll(async () => {
  server = createServer((req, res) => {
    res.end("internal secret")
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  port = (server.address() as AddressInfo).port
})

afterAll(() => {
  server.close()
})

describe("outboundFetch", () => {
  it("control: the loopback server is reachable without the guard", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/`)
    expect(await res.text()).toBe("internal secret")
  })

  it("refuses to connect when the hostname resolves to a private address at connect time (DNS rebinding)", async () => {
    // "localhost" passes the mocked pre-check, but the socket's own lookup
    // resolves it to loopback, which must be refused.
    await expect(outboundFetch(`http://localhost:${port}/`)).rejects.toSatisfy((err: unknown) => {
      const cause = (err as { cause?: unknown }).cause
      return err instanceof SsrfBlockedError || cause instanceof SsrfBlockedError
    })
  })

  it("refuses a literal private IP before connecting", async () => {
    await expect(outboundFetch(`http://127.0.0.1:${port}/`)).rejects.toBeInstanceOf(SsrfBlockedError)
  })
})

describe("outboundFetch redirects", () => {
  it("re-checks every redirect hop and refuses one that points at an internal address", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } }),
    )
    await expect(outboundFetch("https://store.example/wp-json/wc/v3/products")).rejects.toBeInstanceOf(SsrfBlockedError)
    expect(spy).toHaveBeenCalledTimes(1)
    spy.mockRestore()
  })

  it("drops credentials when a redirect leaves the original origin, keeps them on the same origin", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 301, headers: { location: "/v2/products" } }))
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "https://other.example/collect" } }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }))

    const res = await outboundFetch("https://store.example/v1/products", { headers: { Authorization: "Basic c2VjcmV0" } })
    expect(res.status).toBe(200)

    const sentHeaders = spy.mock.calls.map(([, init]) => new Headers((init as RequestInit).headers).get("authorization"))
    expect(sentHeaders).toEqual(["Basic c2VjcmV0", "Basic c2VjcmV0", null])
    expect(String(spy.mock.calls[2][0])).toBe("https://other.example/collect")
    spy.mockRestore()
  })

  it("gives up after too many redirects", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => new Response(null, { status: 302, headers: { location: "/again" } }))
    await expect(outboundFetch("https://loop.example/", { maxRedirects: 2 })).rejects.toBeInstanceOf(SsrfBlockedError)
    expect(spy).toHaveBeenCalledTimes(3)
    spy.mockRestore()
  })
})

// CS-08 (B04-012): every caller header except a small safe allowlist (and
// any request body) must be dropped when a redirect leaves the origin.
describe("outboundFetch cross-origin redirects drop secret headers", () => {
  it("drops custom secret headers (not just Authorization/Cookie) cross-origin, keeps safe ones", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "https://attacker.example/collect" } }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }))

    await outboundFetch("https://api.tenant.example/v1/orders", {
      headers: {
        Accept: "application/json",
        "User-Agent": "Chatmate360/1.0",
        "X-Api-Key": "tenant-secret-key",
        "X-Shopify-Access-Token": "shpat_secret",
        Authorization: "Bearer secret",
      },
    })

    const first = new Headers((spy.mock.calls[0][1] as RequestInit).headers)
    const second = new Headers((spy.mock.calls[1][1] as RequestInit).headers)
    expect(first.get("x-api-key")).toBe("tenant-secret-key")
    expect([...second.keys()].sort()).toEqual(["accept", "user-agent"])
    spy.mockRestore()
  })
})

describe("outboundFetch cross-origin redirect against real loopback servers", () => {
  const seen: { origin: string; path: string; headers: Record<string, string | string[] | undefined>; body: string }[] = []
  let origin: Server
  let target: Server
  let originPort: number
  let targetPort: number
  let restoreLoopback: () => void

  beforeAll(async () => {
    // Test-only hook: lets literal 127.0.0.1 URLs pass the pre-check under
    // vitest. Production checks (and DNS answers) are unaffected.
    restoreLoopback = allowLiteralLoopbackForTests()
    const record = (name: string) => (req: import("node:http").IncomingMessage, cb: (body: string) => void) => {
      let body = ""
      req.on("data", (chunk) => (body += chunk))
      req.on("end", () => {
        seen.push({ origin: name, path: req.url ?? "", headers: req.headers, body })
        cb(body)
      })
    }
    origin = createServer((req, res) =>
      record("origin")(req, () => {
        if (req.url === "/cross") {
          res.writeHead(302, { location: `http://127.0.0.1:${targetPort}/collect` }).end()
        } else if (req.url === "/cross-307") {
          res.writeHead(307, { location: `http://127.0.0.1:${targetPort}/collect` }).end()
        } else if (req.url === "/same") {
          res.writeHead(302, { location: "/final" }).end()
        } else {
          res.end("origin ok")
        }
      }),
    )
    target = createServer((req, res) => record("target")(req, () => res.end("target ok")))
    await new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", resolve))
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve))
    originPort = (origin.address() as AddressInfo).port
    targetPort = (target.address() as AddressInfo).port
  })

  afterAll(() => {
    restoreLoopback()
    origin.close()
    target.close()
  })

  const secretHeaders = {
    Accept: "application/json",
    "User-Agent": "Chatmate360/1.0",
    "X-Api-Key": "tenant-secret-key",
    "X-Custom-Signature": "hmac-secret",
    Authorization: "Bearer secret",
    Cookie: "session=secret",
  }

  it("does not forward secret headers to a different origin", async () => {
    seen.length = 0
    const res = await outboundFetch(`http://127.0.0.1:${originPort}/cross`, { headers: secretHeaders })
    expect(await res.text()).toBe("target ok")

    const atOrigin = seen.find((r) => r.origin === "origin")!
    const atTarget = seen.find((r) => r.origin === "target")!
    expect(atOrigin.headers["x-api-key"]).toBe("tenant-secret-key")
    for (const name of ["x-api-key", "x-custom-signature", "authorization", "cookie"]) {
      expect(atTarget.headers[name], name).toBeUndefined()
    }
    expect(atTarget.headers.accept).toBe("application/json")
    expect(atTarget.headers["user-agent"]).toBe("Chatmate360/1.0")
  })

  it("keeps headers on a same-origin redirect", async () => {
    seen.length = 0
    const res = await outboundFetch(`http://127.0.0.1:${originPort}/same`, { headers: secretHeaders })
    expect(await res.text()).toBe("origin ok")
    expect(seen.map((r) => r.path)).toEqual(["/same", "/final"])
    expect(seen[1].headers["x-api-key"]).toBe("tenant-secret-key")
  })

  it("refuses to replay a request body to a different origin (307)", async () => {
    seen.length = 0
    await expect(
      outboundFetch(`http://127.0.0.1:${originPort}/cross-307`, {
        method: "POST",
        headers: { ...secretHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ email: "visitor@example.com" }),
      }),
    ).rejects.toBeInstanceOf(SsrfBlockedError)
    expect(seen.filter((r) => r.origin === "target")).toHaveLength(0)
  })

  it("the test hook does not apply to hostnames (DNS answers are still checked at connect time)", async () => {
    await expect(outboundFetch(`http://localhost:${targetPort}/`)).rejects.toSatisfy((err: unknown) => {
      const cause = (err as { cause?: unknown }).cause
      return err instanceof SsrfBlockedError || cause instanceof SsrfBlockedError
    })
  })
})
