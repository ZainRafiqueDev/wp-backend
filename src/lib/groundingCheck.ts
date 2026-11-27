

const PRICE_PATTERN = /\$\s?\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?\b/g
const PHONE_PATTERN = /(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/g
const EMAIL_PATTERN = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g
const ISO_DATE_PATTERN = /\b\d{4}-\d{2}-\d{2}\b/g
const SLASH_DATE_PATTERN = /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g
const MONTH_DATE_PATTERN =
  /\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s*\d{4})?\b/gi

const CLAIM_PATTERNS = [PRICE_PATTERN, PHONE_PATTERN, EMAIL_PATTERN, ISO_DATE_PATTERN, SLASH_DATE_PATTERN, MONTH_DATE_PATTERN]


function normalizeForMatch(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9@.]/g, "")
}

export interface GroundingCheckResult {
  ok: boolean
  failedClaims: string[]
}


export function verifyGroundedClaims(answer: string, contextText: string): GroundingCheckResult {
  const normalizedContext = normalizeForMatch(contextText)
  const failedClaims: string[] = []
  const seen = new Set<string>()

  for (const pattern of CLAIM_PATTERNS) {
    pattern.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = pattern.exec(answer)) !== null) {
      const claim = match[0]
      if (seen.has(claim)) continue
      seen.add(claim)

      const normalizedClaim = normalizeForMatch(claim)
      if (normalizedClaim && !normalizedContext.includes(normalizedClaim)) {
        failedClaims.push(claim)
      }
    }
  }

  return { ok: failedClaims.length === 0, failedClaims }
}
