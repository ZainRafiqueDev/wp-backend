import { z } from "zod"

const HTTP_PROTOCOLS = new Set(["http:", "https:"])

export function isHttpUrl(value: string): boolean {
  try {
    return HTTP_PROTOCOLS.has(new URL(value).protocol)
  } catch {
    return false
  }
}

/**
 * A tenant-supplied URL. z.string().url() alone accepts any scheme
 * (javascript:, file:, gopher:, data:), so the scheme is restricted to
 * http/https here; SSRF checks on the resolved address still happen at fetch
 * time (src/lib/crawler/ssrf.ts).
 */
export function httpUrl(message = "Enter a valid http or https URL.") {
  return z.string().trim().url().refine(isHttpUrl, message)
}
