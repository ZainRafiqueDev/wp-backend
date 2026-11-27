import * as cheerio from "cheerio"

import { renderPage } from "./renderPage.js"
import { fetchRobotsRules, isAllowed, type RobotsRules } from "./robots.js"
import { safeFetch } from "./safeFetch.js"
import { fetchSitemapUrls } from "./sitemap.js"
import { assertSafeUrl } from "./ssrf.js"

export interface CrawledPage {
  path: string
  title: string
  text: string
 
  kind?: "crawled" | "live" | "document" | "memory" | "attachment"
}

export interface CrawlResult {
  siteTitle: string
  pages: CrawledPage[]
}


const STATIC_FETCH_TIMEOUT_MS = 8000
const RENDER_TIMEOUT_MS = 15000
const MAX_RESPONSE_BYTES = 3 * 1024 * 1024
const MAX_PAGES = 12
const MAX_DEPTH = 3
const CONCURRENCY = 3
const MAX_TEXT_PER_PAGE = 6000


const SPA_ROOT_SELECTORS = ["#root", "#app", "#__next", "[data-reactroot]", "#__nuxt", "app-root"]

function looksLikeJsShell($: cheerio.CheerioAPI): boolean {
  const hasEmptySpaRoot = SPA_ROOT_SELECTORS.some((sel) => {
    const el = $(sel)
    return el.length > 0 && el.text().trim().length < 40
  })
  if (hasEmptySpaRoot) return true

  const bodyText = $("body").text().replace(/\s+/g, " ").trim()
  const scriptCount = $("script[src], script:not([src])").length
  return bodyText.length < 40 && scriptCount > 0
}

function dedupeKey(url: URL): string {
  const params = [...url.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b))
  const query = params.map(([k, v]) => `${k}=${v}`).join("&")
  return url.origin + url.pathname.replace(/\/$/, "") + (query ? `?${query}` : "")
}


function extractReadableText(html: string, maxLength: number): string {
  const $ = cheerio.load(html)
  $("script, style, noscript, nav, footer, svg").remove()
  const text = $("body").text().replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim()
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text
}

interface QueueItem {
  url: URL
  depth: number
}

async function visitPage(
  item: QueueItem,
  root: URL,
  robotsRules: RobotsRules,
  visited: Set<string>,
  queue: QueueItem[],
  pages: CrawledPage[],
  onTitle: (title: string) => void
): Promise<void> {
  const key = dedupeKey(item.url)
  if (visited.has(key)) return
  visited.add(key)

  const res = await safeFetch(item.url, STATIC_FETCH_TIMEOUT_MS, MAX_RESPONSE_BYTES)
  if (!res.ok || !res.contentType.includes("html")) return

  let html = res.html
  if (looksLikeJsShell(cheerio.load(html))) {
    
    const rendered = await renderPage(item.url, RENDER_TIMEOUT_MS)
    if (rendered) html = rendered
  }

  const $ = cheerio.load(html)
  const title = $("title").first().text().trim() || item.url.pathname || root.hostname
  onTitle(title)

  const text = extractReadableText(html, MAX_TEXT_PER_PAGE)
  if (text) {
    pages.push({ path: (item.url.pathname || "/") + item.url.search, title, text })
  }

  if (item.depth >= MAX_DEPTH) return

  const discovered = new Set<string>()
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href")
    if (!href) return
    try {
      const absolute = new URL(href, item.url)
      absolute.hash = ""
      discovered.add(absolute.toString())
    } catch {
     
    }
  })

  for (const rawUrl of discovered) {
    try {
      const absolute = new URL(rawUrl)
      if (absolute.protocol !== "http:" && absolute.protocol !== "https:") continue
      if (absolute.origin !== root.origin) continue
      if (!isAllowed(robotsRules, absolute.pathname)) continue
      const linkKey = dedupeKey(absolute)
      if (!visited.has(linkKey)) {
        queue.push({ url: absolute, depth: item.depth + 1 })
      }
    } catch {
      // ignore
    }
  }
}


export async function crawlWebsite(rootUrl: string): Promise<CrawlResult> {
  const root = new URL(rootUrl)
  await assertSafeUrl(root)

  const [robotsRules, sitemapUrls] = await Promise.all([
    fetchRobotsRules(root, STATIC_FETCH_TIMEOUT_MS, MAX_RESPONSE_BYTES),
    fetchSitemapUrls(root, STATIC_FETCH_TIMEOUT_MS, MAX_RESPONSE_BYTES),
  ])

  const visited = new Set<string>()
  const queue: QueueItem[] = [{ url: root, depth: 0 }]
  for (const sitemapUrl of sitemapUrls) {
    if (dedupeKey(sitemapUrl) === dedupeKey(root)) continue
    if (!isAllowed(robotsRules, sitemapUrl.pathname)) continue
    queue.push({ url: sitemapUrl, depth: 0 })
  }

  const pages: CrawledPage[] = []
  let siteTitle = ""
  const setTitleOnce = (title: string) => {
    if (!siteTitle) siteTitle = title
  }

  async function worker(): Promise<void> {
    for (;;) {
      if (pages.length >= MAX_PAGES) return
      const next = queue.shift()
      if (!next) return
      await visitPage(next, root, robotsRules, visited, queue, pages, setTitleOnce)
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()))

  return { siteTitle: siteTitle || root.hostname, pages }
}
