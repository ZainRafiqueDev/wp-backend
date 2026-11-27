import { type Browser, type BrowserContext, chromium, type Route } from "playwright"

import { log } from "../logger.js"
import { outboundFetch } from "../outboundFetch.js"
import { SsrfBlockedError } from "./ssrf.js"

// SSRF model for the headless renderer.
//
// Checking a URL and then letting Chromium fetch it is check-then-use:
// Chromium resolves the hostname again on its own, so a DNS-rebinding record
// can pass the check and then point at 127.0.0.1 / 169.254.169.254. Instead,
// every request the page makes is intercepted and performed by Node through
// outboundFetch(), whose socket-level lookup refuses blocked addresses for the
// exact address it connects to; Chromium only receives the response via
// route.fulfill() and never opens a connection of its own.
//
// Redirects are followed inside outboundFetch (each hop re-checked, headers
// stripped cross-origin) because Chromium follows a 3xx handed to
// route.fulfill() itself, without routing the next hop. The fulfilled
// document therefore keeps the original URL as its base URL.
//
// Defence in depth for anything that is not routed (WebSockets, WebRTC, or a
// request type Playwright cannot intercept): the browser is pointed at a dead
// local proxy with no loopback bypass, so such traffic fails instead of
// reaching the network, WebSockets are closed explicitly and service workers
// (whose fetches can bypass routing) are blocked. This assumes nothing on
// the worker host listens on 127.0.0.1:9; if something did, unrouted traffic
// would be sent to it as a proxy (it still could not choose the target IP).
//
// Because Node now buffers every response, each render has a resource
// budget: a cap on request count, on total buffered bytes and on concurrent
// fetches, and one AbortController that cancels every in-flight fetch when
// the render ends or the budget runs out.
//
// Known, low-risk differences from a normal browser: after a redirect the
// page sees the original URL (the redirect target looks same-origin to page
// JS), and redirects are followed by outboundFetch, not by Chromium.

const USER_AGENT = "Chatmate360Bot/1.0 (+https://chatmate360.local/bot)"
const MAX_SUBRESOURCE_BYTES = 10 * 1024 * 1024

export interface RenderLimits {
  /** Requests the page may make (navigation included) before the rest are aborted. */
  maxRequests: number
  /** Total response bytes buffered across the whole render. */
  maxTotalBytes: number
  /** Fetches running at once; the rest wait their turn. */
  maxConcurrent: number
}

export const DEFAULT_RENDER_LIMITS: RenderLimits = {
  maxRequests: 150,
  maxTotalBytes: 25 * 1024 * 1024,
  maxConcurrent: 6,
}

export interface RenderStats {
  requests: number
  bytes: number
  maxInFlight: number
  budgetExceeded: boolean
}

class RenderBudget {
  readonly controller = new AbortController()
  readonly stats: RenderStats = { requests: 0, bytes: 0, maxInFlight: 0, budgetExceeded: false }
  private active = 0
  private readonly waiting: (() => void)[] = []

  constructor(private readonly limits: RenderLimits) {
    this.controller.signal.addEventListener("abort", () => {
      for (const wake of this.waiting.splice(0)) wake()
    })
  }

  get signal(): AbortSignal {
    return this.controller.signal
  }

  /** Reserves a request slot; false once the render is over or the count cap is hit. */
  async acquire(): Promise<boolean> {
    if (this.signal.aborted) return false
    if (this.stats.requests >= this.limits.maxRequests) {
      this.exhaust()
      return false
    }
    this.stats.requests++
    while (this.active >= this.limits.maxConcurrent) {
      await new Promise<void>((resolve) => this.waiting.push(resolve))
      if (this.signal.aborted) return false
    }
    this.active++
    this.stats.maxInFlight = Math.max(this.stats.maxInFlight, this.active)
    return true
  }

  release(): void {
    this.active--
    this.waiting.shift()?.()
  }

  /** Bytes still allowed for one response. */
  remainingBytes(): number {
    return Math.min(MAX_SUBRESOURCE_BYTES, this.limits.maxTotalBytes - this.stats.bytes)
  }

  /** Counts bytes against the render budget; false (and abort everything) once exceeded. */
  consume(bytes: number): boolean {
    if (this.stats.bytes + bytes > this.limits.maxTotalBytes) {
      this.exhaust()
      return false
    }
    this.stats.bytes += bytes
    return true
  }

  private exhaust(): void {
    if (!this.stats.budgetExceeded) {
      this.stats.budgetExceeded = true
      log().warn({ ...this.stats }, "crawler render exceeded its request/byte budget")
    }
    this.controller.abort(new Error("render budget exceeded"))
  }
}
// Nothing listens on the discard port; non-intercepted traffic dead-ends here.
const DEAD_PROXY = "http://127.0.0.1:9"

const browserState: { promise: Promise<Browser> | null } = { promise: null }

function getBrowser(): Promise<Browser> {
  if (!browserState.promise) {
    const launching = chromium
      .launch({
        headless: true,
        proxy: { server: DEAD_PROXY, bypass: "<-loopback>" },
        args: ["--force-webrtc-ip-handling-policy=disable_non_proxied_udp", "--dns-prefetch-disable"],
      })
      .then((browser) => {
        // A crashed/closed browser must not be reused forever.
        browser.on("disconnected", () => {
          if (browserState.promise === launching) browserState.promise = null
        })
        return browser
      })
    launching.catch(() => {
      if (browserState.promise === launching) browserState.promise = null
    })
    browserState.promise = launching
  }
  return browserState.promise
}

export async function closeBrowser(): Promise<void> {
  if (browserState.promise) {
    const browser = await browserState.promise.catch(() => null)
    await browser?.close()
    browserState.promise = null
  }
}

const DROPPED_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "keep-alive",
  "upgrade",
  "accept-encoding",
  "proxy-authorization",
  "proxy-connection",
])
// undici decodes the body, so encoding/length headers no longer describe it.
const DROPPED_RESPONSE_HEADERS = new Set(["content-encoding", "content-length", "transfer-encoding", "connection"])

async function readWithinBudget(res: Response, budget: RenderBudget): Promise<Buffer> {
  const reader = res.body?.getReader()
  if (!reader) return Buffer.alloc(0)
  const maxBytes = budget.remainingBytes()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes || !budget.consume(value.byteLength)) {
        throw new Error("subresource exceeded the render byte budget")
      }
      chunks.push(value)
    }
  } catch (err) {
    await reader.cancel().catch(() => undefined)
    throw err
  }
  // One copy into the fulfilled body; the chunks themselves are not copied.
  return Buffer.concat(chunks, total)
}

function ssrfReason(err: unknown): string | null {
  if (err instanceof SsrfBlockedError) return err.message
  const cause = (err as { cause?: unknown } | null)?.cause
  return cause instanceof SsrfBlockedError ? cause.message : null
}

async function fulfillThroughPinnedFetch(route: Route, timeoutMs: number, budget: RenderBudget): Promise<void> {
  const request = route.request()
  if (!(await budget.acquire())) {
    await route.abort("blockedbyclient").catch(() => {})
    return
  }
  try {
    const target = new URL(request.url())

    const requestHeaders = Object.fromEntries(
      Object.entries(await request.allHeaders()).filter(
        ([name]) => !name.startsWith(":") && !DROPPED_REQUEST_HEADERS.has(name.toLowerCase()),
      ),
    )
    const postData = request.postDataBuffer()
    const res = await outboundFetch(target, {
      method: request.method(),
      headers: requestHeaders,
      body: postData ? new Uint8Array(postData) : undefined,
      signal: AbortSignal.any([budget.signal, AbortSignal.timeout(timeoutMs)]),
    })
    const body = await readWithinBudget(res, budget)

    const responseHeaders: Record<string, string> = {}
    res.headers.forEach((value, name) => {
      if (!DROPPED_RESPONSE_HEADERS.has(name) && name !== "set-cookie") responseHeaders[name] = value
    })
    const cookies = res.headers.getSetCookie()
    if (cookies.length > 0) responseHeaders["set-cookie"] = cookies.join("\n")

    await route.fulfill({ status: res.status, headers: responseHeaders, body })
  } catch (err) {
    const reason = ssrfReason(err)
    if (reason) log().warn({ err: reason }, "crawler blocked an in-page request")
    await route.abort("blockedbyclient").catch(() => {})
  } finally {
    budget.release()
  }
}


export async function renderPage(
  url: URL,
  timeoutMs: number,
  limits: RenderLimits = DEFAULT_RENDER_LIMITS,
  onStats?: (stats: RenderStats) => void,
): Promise<string> {
  let browser: Browser
  try {
    browser = await getBrowser()
  } catch {
    return ""
  }

  let context: BrowserContext
  try {
    context = await browser.newContext({
      userAgent: USER_AGENT,
      acceptDownloads: false,
      serviceWorkers: "block",
    })
  } catch {
    // The browser died between launch and use; the disconnected handler
    // resets the singleton so the next render relaunches it.
    return ""
  }

  const budget = new RenderBudget(limits)
  try {
    await context.route("**/*", (route) => fulfillThroughPinnedFetch(route, timeoutMs, budget))
    await context.routeWebSocket(/.*/, (ws) => {
      ws.close().catch(() => {})
    })

    const page = await context.newPage()
    page.on("dialog", (dialog) => {
      dialog.dismiss().catch(() => {})
    })

    await page.goto(url.toString(), { timeout: timeoutMs, waitUntil: "domcontentloaded" })
    // A short settle window for client-side rendering to actually paint
    // content after the initial HTML/JS loads — domcontentloaded fires
    // before React (or similar) has rendered anything into the DOM.
    await page.waitForTimeout(800)
    return await page.content()
  } catch {
    return ""
  } finally {
    // Cancel every in-flight and queued fetch before tearing the context down.
    budget.controller.abort(new Error("render finished"))
    await context.close().catch(() => {})
    onStats?.({ ...budget.stats })
  }
}
