import * as cheerio from "cheerio"

import { safeFetch } from "./safeFetch.js"
import { assertSafeUrl } from "./ssrf.js"


const MAX_LOC_ENTRIES_PER_FILE = 5000
const MAX_CHILD_SITEMAPS = 20

function safeParseSameOriginUrl(raw: string, rootOrigin: string): URL | null {
  try {
    const url = new URL(raw)
    if (url.protocol !== "http:" && url.protocol !== "https:") return null
    if (url.origin !== rootOrigin) return null
    url.hash = ""
    return url
  } catch {
    return null
  }
}

function extractLocs($: cheerio.CheerioAPI, selector: string, limit: number): string[] {
  const locs: string[] = []
  $(selector).each((_, el) => {
    if (locs.length >= limit) return false
    const text = $(el).text().trim()
    if (text) locs.push(text)
  })
  return locs
}


async function parseSitemapDocument(
  xml: string,
  rootOrigin: string,
  timeoutMs: number,
  maxBytes: number,
  allowChildSitemaps: boolean
): Promise<URL[]> {
  const $ = cheerio.load(xml, { xmlMode: true })
  const urls: URL[] = []

  for (const loc of extractLocs($, "urlset > url > loc", MAX_LOC_ENTRIES_PER_FILE)) {
    const parsed = safeParseSameOriginUrl(loc, rootOrigin)
    if (parsed) urls.push(parsed)
  }

  if (allowChildSitemaps) {
    const childLocs = extractLocs($, "sitemapindex > sitemap > loc", MAX_CHILD_SITEMAPS)
    for (const loc of childLocs) {
      const childUrl = safeParseSameOriginUrl(loc, rootOrigin)
      if (!childUrl) continue
      try {
        await assertSafeUrl(childUrl)
      } catch {
        continue
      }
      const childRes = await safeFetch(childUrl, timeoutMs, maxBytes)
      if (!childRes.ok) continue
      // One hop only — a hostile "sitemap of sitemaps of sitemaps" can't
      // multiply requests without bound.
      const childUrls = await parseSitemapDocument(childRes.html, rootOrigin, timeoutMs, maxBytes, false)
      urls.push(...childUrls)
      if (urls.length >= MAX_LOC_ENTRIES_PER_FILE) break
    }
  }

  return urls
}

export async function fetchSitemapUrls(root: URL, timeoutMs: number, maxBytes: number): Promise<URL[]> {
  const sitemapUrl = new URL("/sitemap.xml", root)
  try {
    await assertSafeUrl(sitemapUrl)
  } catch {
    return []
  }

  const res = await safeFetch(sitemapUrl, timeoutMs, maxBytes)
  if (!res.ok) return []

  const urls = await parseSitemapDocument(res.html, root.origin, timeoutMs, maxBytes, true)

  const safeUrls: URL[] = []
  for (const url of urls) {
    try {
      await assertSafeUrl(url)
      safeUrls.push(url)
    } catch {
      // skip
    }
  }
  return safeUrls
}
