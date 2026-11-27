import { pinnedFetch } from "../outboundFetch.js"
import { assertSafeUrl } from "./ssrf.js"

const USER_AGENT = "Chatmate360Bot/1.0 (+https://chatmate360.local/bot)"
const MAX_REDIRECTS = 5


async function readBodyCapped(res: Response, maxBytes: number): Promise<string> {
  const reader = res.body?.getReader()
  if (!reader) return await res.text()

  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        throw new Error(`response exceeded ${maxBytes}-byte cap`)
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf-8")
}

export interface SafeFetchResult {
  ok: boolean
  statusCode: number | null
  contentType: string
  html: string
}


export async function safeFetch(
  startUrl: URL,
  timeoutMs: number,
  maxBytes: number
): Promise<SafeFetchResult> {
  let current = startUrl
  for (let hop = 0; ; hop++) {
    try {
      await assertSafeUrl(current)
    } catch {
      return { ok: false, statusCode: null, contentType: "", html: "" }
    }

    let res: Response
    try {
      res = await pinnedFetch(current, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xml" },
      })
    } catch {
      return { ok: false, statusCode: null, contentType: "", html: "" }
    }

    const location = res.headers.get("location")
    if (res.status >= 300 && res.status < 400 && location) {
      if (hop >= MAX_REDIRECTS) return { ok: false, statusCode: res.status, contentType: "", html: "" }
      try {
        current = new URL(location, current)
      } catch {
        return { ok: false, statusCode: res.status, contentType: "", html: "" }
      }
      continue
    }

    const contentType = res.headers.get("content-type") || ""
    if (!res.ok) return { ok: false, statusCode: res.status, contentType, html: "" }

    try {
      const html = await readBodyCapped(res, maxBytes)
      return { ok: true, statusCode: res.status, contentType, html }
    } catch {
      return { ok: false, statusCode: res.status, contentType, html: "" }
    }
  }
}
