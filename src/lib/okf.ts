export const OKF_TYPES = [
  "Policy",
  "PricingTable",
  "OperatingInfo",
  "Procedure",
  "FAQ",
  "ProductSpec",
  "SLADefinition",
  "Glossary",
] as const

export type OKFType = (typeof OKF_TYPES)[number]

export type OKFCreatedBy = "human" | "ai_suggested" | "ai_extracted"

export type OKFConcept = {
  id: string
  chatbotId: string
  type: OKFType
  title: string
  description: string | null
  tags: string[]
  resourceUrl: string | null
  okfVersion: string
  bodyMd: string
  isActive: boolean
  createdBy: OKFCreatedBy
  approvedAt: string | null
  sourceDocumentId: string | null
  servedCount: number
  createdAt: string
  updatedAt: string
}

export function isOkfType(value: string): value is OKFType {
  return (OKF_TYPES as readonly string[]).includes(value)
}

export function normalizeOkfTitle(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  if (!a.length) return b.length
  if (!b.length) return a.length
  const prev = new Array<number>(b.length + 1)
  const cur = new Array<number>(b.length + 1)
  for (let j = 0; j <= b.length; j++) prev[j] = j
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost)
    }
    for (let j = 0; j <= b.length; j++) prev[j] = cur[j]
  }
  return prev[b.length]
}

const STOP = new Set(["the", "a", "an", "is", "are", "was", "what", "how", "do", "does", "to", "of", "for", "in", "on", "and", "or"])

export function significantTokens(text: string): string[] {
  return normalizeOkfTitle(text)
    .split(" ")
    .filter((token) => token.length > 2 && !STOP.has(token))
}

export function bodyAnswersQuery(bodyMd: string, query: string): boolean {
  const tokens = significantTokens(query)
  if (tokens.length === 0) return true
  const hay = normalizeOkfTitle(bodyMd)
  const hits = tokens.filter((token) => hay.includes(token)).length
  return hits >= Math.min(2, tokens.length)
}

export function classifyOkfQueryType(query: string): OKFType | null {
  const q = query.toLowerCase()
  if (/\b(price|pricing|cost|fee|plan|subscription|charge)\b/.test(q)) return "PricingTable"
  if (/\b(refund|return|privacy|policy|terms)\b/.test(q)) return "Policy"
  if (/\b(hour|open|close|location|address|contact|phone)\b/.test(q)) return "OperatingInfo"
  if (/\b(how to|step|procedure|process|request)\b/.test(q)) return "Procedure"
  if (/\b(sla|uptime|guarantee|response time)\b/.test(q)) return "SLADefinition"
  if (/\b(sku|spec|feature|product)\b/.test(q)) return "ProductSpec"
  if (/\b(mean|acronym|glossary|definition)\b/.test(q)) return "Glossary"
  if (/\b(faq|frequently)\b/.test(q)) return "FAQ"
  return null
}

export function formatOKFAnswer(concept: Pick<OKFConcept, "title" | "bodyMd" | "resourceUrl">, query: string): string {
  const body = concept.bodyMd.trim()
  let excerpt = body
  if (body.length > 500) {
    excerpt = extractRelevantSection(body, query) || body.slice(0, 500).trim()
  }
  const source = concept.resourceUrl
    ? `Source: ${concept.title} (${concept.resourceUrl})`
    : `Source: ${concept.title}`
  return `${excerpt}\n\n${source}`
}

function extractRelevantSection(body: string, query: string): string | null {
  const tokens = significantTokens(query)
  const parts = body.split(/^#{1,3}\s+/m).map((part) => part.trim()).filter(Boolean)
  if (parts.length <= 1) return null
  let best = parts[0]
  let bestHits = -1
  for (const part of parts) {
    const hay = normalizeOkfTitle(part)
    const hits = tokens.filter((token) => hay.includes(token)).length
    if (hits > bestHits) {
      bestHits = hits
      best = part
    }
  }
  return best.slice(0, 2000)
}

export function toOkfMarkdownFile(concept: OKFConcept): string {
  const tags = concept.tags.length > 0 ? `[${concept.tags.join(", ")}]` : "[]"
  const resource = concept.resourceUrl ? `\nresource: ${concept.resourceUrl}` : ""
  return `---
type: ${concept.type}
title: ${yamlEscape(concept.title)}
description: ${yamlEscape(concept.description || "")}
tags: ${tags}${resource}
timestamp: ${concept.updatedAt}
okf_version: ${concept.okfVersion}
---

${concept.bodyMd.trim()}
`
}

function yamlEscape(value: string): string {
  if (/[:#[\]{}&*?]|^\s|\s$/.test(value)) return JSON.stringify(value)
  return value || '""'
}
