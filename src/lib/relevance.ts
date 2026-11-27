import type { CrawledPage } from "./crawler/crawl.js"

const STOPWORDS = new Set([
  "what", "when", "where", "which", "who", "whom", "whose", "why", "how",
  "does", "did", "do", "is", "are", "was", "were", "will", "would", "could",
  "should", "have", "has", "had", "with", "this", "that", "these", "those",
  "your", "you", "the", "and", "for", "about", "tell", "give", "please",
  "can", "there", "here", "from", "into", "than", "then",
])

// Small closed synonym sets for tokens the keyword gate otherwise misses
// (e.g. "websites" vs source text "web development"). Kept deliberately
// narrow — this is still a pre-LLM cost gate, not full query rewriting.
const SYNONYM_GROUPS: string[][] = [
  ["web", "website", "websites", "site", "sites", "webpage", "webpages"],
  ["dev", "development", "developer", "developers", "developing", "developed"],
  ["service", "services"],
  ["app", "apps", "application", "applications"],
]

function meaningfulWords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    // length >= 3 so short domain tokens like "web"/"dev"/"app"/"site" count
    .filter((word) => word.length >= 3 && !STOPWORDS.has(word))
}

function crudeStem(word: string): string {
  return word.replace(/(?:ments|ment|ations|ation|ings|ing|ers|er|ies|es|s)$/i, "")
}

function expandTokens(words: string[]): Set<string> {
  const out = new Set<string>()
  for (const word of words) {
    out.add(word)
    const stem = crudeStem(word)
    if (stem.length >= 3) out.add(stem)
    for (const group of SYNONYM_GROUPS) {
      if (group.includes(word) || group.includes(stem)) {
        for (const g of group) out.add(g)
      }
    }
  }
  return out
}

function questionTokens(question: string): Set<string> {
  return expandTokens(meaningfulWords(question))
}

function pageMatchScore(tokens: Set<string>, page: CrawledPage): number {
  if (tokens.size === 0) return 0
  const pageText = `${page.title} ${page.text}`.toLowerCase()
  const pageTokens = expandTokens(meaningfulWords(pageText))
  let score = 0
  for (const token of tokens) {
    if (pageText.includes(token) || pageTokens.has(token)) score += 1
  }
  return score
}

// WP-2.3 hybrid retrieval (documentIngestion.lookupRelevantDocumentChunks)
// is what finds SKU/id chunks. This gate only scores pages already retrieved.
export function hasRelevantContent(question: string, pages: CrawledPage[]): boolean {
  const tokens = questionTokens(question)
  if (tokens.size === 0) return true

  for (const page of pages) {
    if (pageMatchScore(tokens, page) > 0) return true
  }
  return false
}

/** Stable sort: higher synonym/token overlap first. Live/doc order is caller-owned. */
export function rankPagesByRelevance(question: string, pages: CrawledPage[]): CrawledPage[] {
  const tokens = questionTokens(question)
  if (tokens.size === 0) return pages

  return pages
    .map((page, index) => ({ page, index, score: pageMatchScore(tokens, page) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.page)
}
