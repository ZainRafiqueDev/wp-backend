import type { CrawledPage } from "./crawler/crawl.js"
import { assertSafeUrl } from "./crawler/ssrf.js"
import { outboundFetch } from "./outboundFetch.js"
import { cacheKey, getCached, setCached } from "./cache.js"
import { env } from "../env.js"
import { log } from "./logger.js"
import { getBackendLinkForChatbot } from "../services/integration.service.js"


const BACKEND_LINK_TIMEOUT_MS = 4000
const MAX_RESPONSE_CHARS = 4000

const MAX_PRODUCTS_IN_CONTEXT = 20
const MAX_AVAILABILITY_LOOKUPS = 5

interface BackendProduct {
  id?: string | number
  [key: string]: unknown
}

function joinUrl(baseUrl: string, path: string): URL {

  return new URL(`${baseUrl}${path}`)
}

async function fetchJson(url: URL, apiKey: string | null): Promise<unknown | null> {
  await assertSafeUrl(url)
  const headers: Record<string, string> = { Accept: "application/json" }
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`

  const res = await outboundFetch(url, { headers, signal: AbortSignal.timeout(BACKEND_LINK_TIMEOUT_MS) })
  if (!res.ok) return null
  return res.json().catch(() => null)
}

function productToPage(product: BackendProduct): CrawledPage {
  const id = String(product.id ?? "")
  const text = JSON.stringify(product).slice(0, MAX_RESPONSE_CHARS)
  return { path: `backend:${id}`, title: `Product ${id}`, text, kind: "live" }
}

function availabilityToPage(id: string, availability: unknown): CrawledPage {
  const text = JSON.stringify(availability).slice(0, MAX_RESPONSE_CHARS)
  return { path: `backend:${id}:availability`, title: `Availability for ${id}`, text, kind: "live" }
}


async function fetchBackendLiveContextUncached(chatbotId: string): Promise<CrawledPage[]> {
  const link = await getBackendLinkForChatbot(chatbotId)
  if (!link) return []

  let productsData: unknown
  try {
    productsData = await fetchJson(joinUrl(link.apiBaseUrl, "/products"), link.apiKey)
  } catch (err) {
    log().warn(
      { chatbotId, err: err instanceof Error ? err.message : String(err) },
      "backend link /products call failed or was blocked",
    )
    return []
  }

  if (!Array.isArray(productsData)) return []
  const products = (productsData as BackendProduct[]).slice(0, MAX_PRODUCTS_IN_CONTEXT)
  if (products.length === 0) return []

  const pages: CrawledPage[] = products.map(productToPage)

  const lookupTargets = products.slice(0, MAX_AVAILABILITY_LOOKUPS).filter((p) => p.id !== undefined && p.id !== null)
  const availabilityResults = await Promise.allSettled(
    lookupTargets.map(async (product) => {
      const id = String(product.id)
      const availability = await fetchJson(
        joinUrl(link.apiBaseUrl, `/products/${encodeURIComponent(id)}/availability`),
        link.apiKey,
      )
      return { id, availability }
    }),
  )

  for (const result of availabilityResults) {
    if (result.status === "fulfilled" && result.value.availability !== null) {
      pages.push(availabilityToPage(result.value.id, result.value.availability))
    }
  }

  log().info(
    { chatbotId, productCount: products.length, availabilityLookups: lookupTargets.length },
    "backend link read tier fetched",
  )
  return pages
}


export async function fetchBackendLiveContext(chatbotId: string, cacheVersion: number): Promise<CrawledPage[]> {
  const key = cacheKey(chatbotId, "backend-link", String(cacheVersion))
  const cached = await getCached<CrawledPage[]>(key)
  if (cached) return cached

  const pages = await fetchBackendLiveContextUncached(chatbotId)
  await setCached(key, pages, env.backendLinkCacheTtlSeconds)
  return pages
}
