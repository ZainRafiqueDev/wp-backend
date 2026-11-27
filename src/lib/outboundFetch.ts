import dns, { type LookupAddress, type LookupOptions } from "node:dns"

import { Agent } from "undici"

import { assertSafeUrl, isPrivateAddress, SsrfBlockedError } from "./crawler/ssrf.js"

// SSRF-hardened fetch for every outbound call whose URL a tenant controls
// (crawler, WooCommerce, Bookly, custom actions, backend links).
//
// assertSafeUrl() alone is check-then-use: it resolves the hostname, then
// fetch() resolves it *again* on its own. A DNS record with a short TTL can
// answer with a public address for the check and 127.0.0.1 / 169.254.169.254
// for the real connection (DNS rebinding). The dispatcher below validates the
// addresses inside the socket's own lookup, so the address that is checked is
// exactly the address that is connected to.
//
// Redirects are never followed automatically: each hop is re-validated, and
// every caller header except Accept/Accept-Language/User-Agent (and any body)
// is dropped when a redirect leaves the original origin, so a
// store or API that redirects elsewhere cannot capture its API key or reach an
// internal address.

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void

function pinnedLookup(hostname: string, options: LookupOptions, callback: LookupCallback): void {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, "")
    if (addresses.length === 0) return callback(new SsrfBlockedError(`no DNS records for ${hostname}`), "")
    const blocked = addresses.find((entry) => isPrivateAddress(entry.address))
    if (blocked) {
      return callback(new SsrfBlockedError(`${hostname} resolves to blocked address ${blocked.address}`), "")
    }
    if (options.all) return callback(null, addresses)
    callback(null, addresses[0].address, addresses[0].family)
  })
}

const ssrfSafeDispatcher = new Agent({ connect: { lookup: pinnedLookup as never } })

const MAX_REDIRECTS = 5

/**
 * One request, no redirect following, connected only to a validated address.
 * For callers that run their own redirect loop (the crawler's safeFetch).
 */
export function pinnedFetch(url: URL, init: Omit<RequestInit, "redirect"> = {}): Promise<Response> {
  // `dispatcher` is a Node-specific fetch option, hence the widened type.
  return fetch(url, { ...init, redirect: "manual", dispatcher: ssrfSafeDispatcher } as RequestInit)
}

export type OutboundRequestInit = Omit<RequestInit, "redirect"> & { maxRedirects?: number }

// The only caller-supplied headers that survive a redirect to a different
// origin. Everything else (Authorization, Cookie, X-Api-Key and any other
// custom secret header a tenant configured on a Custom Action) is dropped.
const CROSS_ORIGIN_SAFE_HEADERS = new Set(["accept", "accept-language", "user-agent"])

// Keeps the caller's header-name casing (new Headers() would lowercase it).
function headersToRecord(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) return {}
  if (headers instanceof Headers) return Object.fromEntries(headers.entries())
  if (Array.isArray(headers)) return Object.fromEntries(headers)
  return { ...headers }
}

/**
 * fetch() with SSRF protection: blocks private/reserved targets at connect time
 * (not just before it), and follows at most `maxRedirects` redirects by hand,
 * re-checking every hop. Throws SsrfBlockedError for a blocked target.
 */
export async function outboundFetch(input: URL | string, init: OutboundRequestInit = {}): Promise<Response> {
  const { maxRedirects = MAX_REDIRECTS, ...rest } = init
  const startOrigin = new URL(input).origin
  let current = new URL(input)
  let method = (rest.method ?? "GET").toUpperCase()
  let body = rest.body
  let headers = headersToRecord(rest.headers)

  for (let hop = 0; ; hop++) {
    // Fast, clear failure for literal IPs and obviously-internal names; the
    // dispatcher's lookup is what actually enforces it at connect time.
    await assertSafeUrl(current)

    const res = await pinnedFetch(current, { ...rest, method, body, headers })

    if (!(res.status >= 300 && res.status < 400)) return res
    const location = res.headers.get("location")
    if (!location) return res

    await res.body?.cancel().catch(() => undefined)
    if (hop >= maxRedirects) {
      throw new SsrfBlockedError(`too many redirects (more than ${maxRedirects})`)
    }

    const next = new URL(location, current)
    // Same method rewrite browsers apply: 303 always, and 301/302 for POST,
    // become a body-less GET; 307/308 keep the method and body.
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === "POST")) {
      method = "GET"
      body = undefined
      headers = Object.fromEntries(Object.entries(headers).filter(([name]) => name.toLowerCase() !== "content-type"))
    }
    if (next.origin !== startOrigin) {
      // A body can carry visitor PII or secrets; never replay it to a
      // different origin (only reachable via 307/308).
      if (body !== undefined && body !== null) {
        throw new SsrfBlockedError(`refusing to forward a request body to a different origin (${next.origin})`)
      }
      headers = Object.fromEntries(
        Object.entries(headers).filter(([name]) => CROSS_ORIGIN_SAFE_HEADERS.has(name.toLowerCase())),
      )
    }
    current = next
  }
}
