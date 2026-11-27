/**
 * WP-3.4: parsing and normalisation for LLM-extracted customer facts.
 *
 * Kept free of DB/AI imports so the parser is unit-testable on its own — the
 * service layer (sessionMemory.service.ts) owns the model call and the writes.
 */

export interface ExtractedFact {
  key: string
  value: string
  confidence: number
}

const MAX_KEY_CHARS = 64
const MAX_VALUE_CHARS = 500

/** snake_case, ASCII-ish, stable across turns so upserts collapse duplicates. */
export function normalizeFactKey(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, MAX_KEY_CHARS)
}

function clampConfidence(raw: unknown): number {
  const value = typeof raw === "number" ? raw : Number(raw)
  if (!Number.isFinite(value)) return 0.5
  return Math.min(1, Math.max(0, value))
}

/**
 * Pulls the first JSON array out of a model response and coerces it into
 * facts. Models wrap JSON in prose or fences often enough that requiring a
 * clean payload would drop most real responses, so this scans for the array
 * rather than parsing the whole string.
 *
 * Never throws: an unparseable response yields an empty list, which the
 * caller treats as "no new facts this turn".
 */
export function parseExtractedFacts(raw: string | null | undefined, maxFacts: number): ExtractedFact[] {
  if (!raw) return []

  const start = raw.indexOf("[")
  const end = raw.lastIndexOf("]")
  if (start === -1 || end <= start) return []

  let parsed: unknown
  try {
    parsed = JSON.parse(raw.slice(start, end + 1))
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []

  const byKey = new Map<string, ExtractedFact>()
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue
    const record = entry as Record<string, unknown>
    const key = normalizeFactKey(typeof record.key === "string" ? record.key : "")
    const value = typeof record.value === "string" ? record.value.trim().slice(0, MAX_VALUE_CHARS) : ""
    if (!key || !value) continue

    const fact = { key, value, confidence: clampConfidence(record.confidence) }
    // Later duplicates win: a model that restates a fact usually refines it.
    byKey.set(key, fact)
    if (byKey.size > maxFacts) break
  }

  return [...byKey.values()].slice(0, maxFacts)
}

/** Deterministic, model-free rendering of facts for the answering prompt. */
export function formatFactsForPrompt(facts: { key: string; value: string }[]): string {
  return facts.map((fact) => `- ${fact.key.replace(/_/g, " ")}: ${fact.value}`).join("\n")
}
