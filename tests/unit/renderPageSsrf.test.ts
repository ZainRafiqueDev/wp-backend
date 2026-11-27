import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

// CS-08 (B04-028): the headless renderer used to check a URL and then let
// Chromium resolve and connect on its own (DNS rebinding). Every request is
// now performed by Node through the pinned dispatcher and handed to Chromium
// via route.fulfill(). "localhost" plays the rebinding hostname: the
// pre-check (dns/promises, mocked) sees a public answer, but the real
// connect-time lookup resolves it to loopback, which must never be reached.
vi.mock("node:dns/promises", () => ({
  default: { lookup: async () => [{ address: "93.184.216.34", family: 4 }] },
}))

const { renderPage, closeBrowser } = await import("../../src/lib/crawler/renderPage.js")
const { allowLiteralLoopbackForTests } = await import("../../src/lib/crawler/ssrf.js")

let site: Server
let internal: Server
let sitePort: number
let internalPort: number
let internalHits: string[] = []
let restoreLoopback: () => void

beforeAll(async () => {
  // Test-only hook: the literal 127.0.0.1 tenant "site" passes the pre-check.
  restoreLoopback = allowLiteralLoopbackForTests()
  internal = createServer((req, res) => {
    internalHits.push(req.url ?? "")
    res.setHeader("access-control-allow-origin", "*")
    res.end("internal secret")
  })
  await new Promise<void>((resolve) => internal.listen(0, "127.0.0.1", resolve))
  internalPort = (internal.address() as AddressInfo).port

  site = createServer((req, res) => {
    if (req.url === "/") {
      res.writeHead(302, { location: "/page" }).end()
      return
    }
    res.setHeader("content-type", "text/html")
    res.end(`<!doctype html><html><body>
      <h1 id="title">Rendered tenant page</h1>
      <img src="http://localhost:${internalPort}/img">
      <script src="http://localhost:${internalPort}/script.js"></script>
      <script>
        fetch("http://localhost:${internalPort}/fetch").catch(() => {});
        document.getElementById("title").textContent += " (js ran)";
      </script>
    </body></html>`)
  })
  await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve))
  sitePort = (site.address() as AddressInfo).port
})

afterAll(async () => {
  restoreLoopback()
  await closeBrowser()
  site.close()
  internal.close()
})

describe("renderPage SSRF (CS-08)", () => {
  it("renders the page (following a redirect) but never reaches an address that rebinds to loopback", async () => {
    internalHits = []
    const html = await renderPage(new URL(`http://127.0.0.1:${sitePort}/`), 15_000)
    expect(html).toContain("Rendered tenant page (js ran)")
    // Give any stray request a moment to land.
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(internalHits).toEqual([])
  }, 60_000)

  it("returns empty for a blocked start URL", async () => {
    internalHits = []
    const html = await renderPage(new URL(`http://localhost:${internalPort}/`), 15_000)
    expect(html).not.toContain("internal secret")
    expect(internalHits).toEqual([])
  }, 60_000)
})

// CS-08 review: every response is buffered in Node, so a render must have a
// request-count cap, a total-byte budget, bounded concurrency, and must abort
// every in-flight fetch when it ends.
describe("renderPage resource budget (CS-08)", () => {
  let heavy: Server
  let heavyPort: number
  let open = 0
  let bigHits = 0

  beforeAll(async () => {
    const chunk = Buffer.alloc(64 * 1024, 0x61)
    heavy = createServer((req, res) => {
      const path = req.url ?? ""
      if (path === "/" || path === "/slow-page") {
        const target = path === "/" ? "/big" : "/slow"
        res.setHeader("content-type", "text/html")
        res.end(`<!doctype html><html><body><h1>Heavy page</h1><script>
          for (let i = 0; i < 400; i++) fetch("${target}?" + i).catch(() => {});
        </script></body></html>`)
        return
      }
      if (path.startsWith("/big")) bigHits++
      open++
      res.on("close", () => {
        open--
      })
      res.setHeader("content-type", "application/octet-stream")
      // /big: 1 MB in 64 KB chunks; /slow: effectively endless trickle.
      let sent = 0
      const limit = path.startsWith("/big") ? 16 : Number.POSITIVE_INFINITY
      const timer = setInterval(() => {
        if (res.destroyed) return clearInterval(timer)
        if (sent >= limit) {
          clearInterval(timer)
          res.end()
          return
        }
        sent++
        res.write(chunk)
      }, 5)
      res.on("close", () => clearInterval(timer))
    })
    await new Promise<void>((resolve) => heavy.listen(0, "127.0.0.1", resolve))
    heavyPort = (heavy.address() as AddressInfo).port
  })

  afterAll(() => {
    heavy.close()
  })

  const limits = { maxRequests: 40, maxTotalBytes: 3 * 1024 * 1024, maxConcurrent: 4 }

  it("caps request count, total bytes and concurrency for a page that fires hundreds of large fetches", async () => {
    let stats: { requests: number; bytes: number; maxInFlight: number; budgetExceeded: boolean } | undefined
    const html = await renderPage(new URL(`http://127.0.0.1:${heavyPort}/`), 15_000, limits, (s) => (stats = s))
    expect(html).toContain("Heavy page")
    expect(stats).toBeDefined()
    expect(stats!.budgetExceeded).toBe(true)
    expect(stats!.bytes).toBeLessThanOrEqual(limits.maxTotalBytes)
    expect(stats!.requests).toBeLessThanOrEqual(limits.maxRequests)
    expect(stats!.maxInFlight).toBeLessThanOrEqual(limits.maxConcurrent)
    expect(bigHits).toBeLessThanOrEqual(limits.maxRequests)
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(open).toBe(0)
  }, 60_000)

  it("aborts every in-flight fetch as soon as the render ends", async () => {
    const generous = { maxRequests: 1000, maxTotalBytes: 500 * 1024 * 1024, maxConcurrent: 6 }
    let stats: { maxInFlight: number } | undefined
    const html = await renderPage(new URL(`http://127.0.0.1:${heavyPort}/slow-page`), 15_000, generous, (s) => (stats = s))
    expect(html).toContain("Heavy page")
    expect(stats!.maxInFlight).toBe(6)
    // The trickling responses would run to the 15 s timeout if not aborted.
    const deadline = Date.now() + 2_000
    while (open > 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50))
    expect(open).toBe(0)
  }, 60_000)
})
