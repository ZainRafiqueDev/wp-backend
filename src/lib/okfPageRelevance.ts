// Deterministic, zero-cost pre-filter for "is this crawled page worth
// spending an LLM call on to look for OKF-suggestable facts" — deliberately
// NOT an LLM classifier itself (that would be spending AI money to decide
// whether to spend AI money). Two independent signals, either one qualifies
// a page unless the deny list vetoes it first:
//   1. the URL path itself looks like a policy/pricing/FAQ page
//   2. the page text contains a policy-shaped pattern (a currency amount, a
//      day/hour count, or a named-policy phrase) even when the URL doesn't
//      give it away (single-page sites, `/page?id=42`, etc.)
const DENY_PATTERNS = [/\bblog\b/, /\bnews\b/, /\bpress\b/, /\bcareers?\b/, /\bteam\b/, /\babout(-us)?\b/]

const ALLOW_URL_PATTERNS = [
  /\bpricing\b/,
  /\bplans?\b/,
  /\brefunds?\b/,
  /\breturns?\b/,
  /\bcancel(lation)?s?\b/,
  /\bpolic(y|ies)\b/,
  /\bterms\b/,
  /\btos\b/,
  /\bprivacy\b/,
  /\bfaqs?\b/,
  /\bshipping\b/,
  /\bdelivery\b/,
  /\bwarrant(y|ies)\b/,
  /\bguarantees?\b/,
  /\bhours\b/,
  /\bsupport\b/,
  /\bhelp\b/,
  /\bsla\b/,
  /\bsubscriptions?\b/,
]

const CONTENT_SIGNAL_PATTERNS = [
  /[$€£]\s?\d/, // a currency amount
  /\b\d+\s*(day|hour|business day|week)s?\b/i, // "30 days", "24 hours"
  /\brefund policy\b/i,
  /\bcancellation policy\b/i,
  /\bprivacy policy\b/i,
  /\bmoney[- ]back\b/i,
]

// Only the first 5000 chars are checked — a content signal buried deep in a
// long page is exactly the kind of low-confidence match not worth a false
// positive for; genuine policy pages state their terms up front.
const CONTENT_SAMPLE_CHARS = 5000

function urlPath(url: string): string {
  try {
    return new URL(url).pathname.toLowerCase()
  } catch {
    return url.toLowerCase()
  }
}

/**
 * Higher = more confident this page is worth an OKF-suggestion pass.
 * 0 means "skip it" — either the deny list vetoed it, or neither signal
 * matched. Used to rank candidate pages when a crawl run has more
 * qualifying pages than the per-run cap allows.
 */
export function scoreOkfRelevance(url: string, text: string): number {
  const path = urlPath(url)
  if (DENY_PATTERNS.some((pattern) => pattern.test(path))) return 0

  let score = 0
  if (ALLOW_URL_PATTERNS.some((pattern) => pattern.test(path))) score += 2

  const sample = text.slice(0, CONTENT_SAMPLE_CHARS)
  for (const pattern of CONTENT_SIGNAL_PATTERNS) {
    if (pattern.test(sample)) score += 1
  }

  return score
}

export function isLikelyOkfRelevantPage(url: string, text: string): boolean {
  return scoreOkfRelevance(url, text) > 0
}
