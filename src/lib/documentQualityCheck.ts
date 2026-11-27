import { env } from "../env.js"

export type QualityCheckResult = { ok: true } | { ok: false; reason: string }

// Cheap, free, always-on first pass before spending an OpenAI call: a
// correctly-extracted document is overwhelmingly letters/digits/whitespace/
// punctuation. A failed extraction (encrypted PDF, scanned image with no
// OCR layer, binary leaking through) tends to produce a wall of control
// characters, replacement characters, or high-byte noise instead — this
// catches that class of failure without any API cost.
const PRINTABLE_PATTERN = /[a-zA-Z0-9\s.,!?;:'"()\-–—/%$@&]/g
const MIN_PRINTABLE_RATIO = 0.6
const MIN_LENGTH_FOR_RATIO_CHECK = 40

export function heuristicQualityCheck(text: string): QualityCheckResult {
  if (text.length < MIN_LENGTH_FOR_RATIO_CHECK) {
    console.log(`[documentQualityCheck] heuristic: text too short (${text.length} chars) to ratio-check, passing through`)
    return { ok: true }
  }
  const printableCount = (text.match(PRINTABLE_PATTERN) || []).length
  const ratio = printableCount / text.length
  console.log(`[documentQualityCheck] heuristic: length=${text.length} printableCount=${printableCount} ratio=${ratio.toFixed(3)}`)
  if (ratio < MIN_PRINTABLE_RATIO) {
    return {
      ok: false,
      reason: "The extracted content looks corrupted or unreadable (mostly non-text characters) — this file may be a scanned image, encrypted, or in an unsupported encoding.",
    }
  }
  return { ok: true }
}

const SAMPLE_CHARS = 4000

interface OpenAiVerdict {
  valid: boolean
  reason: string
}

function parseVerdict(raw: string): OpenAiVerdict | null {
  try {
    // The model is asked for bare JSON but sometimes wraps it in a code
    // fence anyway — strip that before parsing rather than failing on it.
    const cleaned = raw.trim().replace(/^```json\s*/i, "").replace(/^```\s*/, "").replace(/```\s*$/, "")
    const parsed = JSON.parse(cleaned) as Partial<OpenAiVerdict>
    if (typeof parsed.valid !== "boolean") return null
    return { valid: parsed.valid, reason: typeof parsed.reason === "string" ? parsed.reason : "" }
  } catch (err) {
    console.error(`[documentQualityCheck] parseVerdict: failed to parse model response as JSON (length=${raw.length}):`, err instanceof Error ? err.message : String(err))
    return null
  }
}

// Second pass, only when an OpenAI key is configured: hands the model a
// sample of the extracted text and asks it to judge whether this reads as
// genuine, coherent document content versus extraction noise (garbled
// OCR, boilerplate-only, wrong-encoding artifacts the heuristic ratio
// check might not catch — e.g. valid-looking characters arranged into
// nonsense). Skips cleanly (treated as a pass) when no key is set, same
// "degrade gracefully without a key" behavior the rest of the AI features
// already follow (see hasAiProvider in env.ts) — this is an extra safety
// net, not a hard requirement for document ingestion to function.
export async function llmQualityCheck(text: string, fileName: string, fileType: string): Promise<QualityCheckResult> {
  if (!env.openaiApiKey) {
    console.log("[documentQualityCheck] llmQualityCheck: no OPENAI_API_KEY configured, skipping LLM verification")
    return { ok: true }
  }

  const sample = text.slice(0, SAMPLE_CHARS)
  console.log(`[documentQualityCheck] llmQualityCheck: START fileName="${fileName}" fileType=${fileType} sampleLength=${sample.length}`)

  const prompt =
    `You are checking whether text extracted from an uploaded "${fileType}" file named "${fileName}" was ` +
    `extracted correctly, before it gets chunked and embedded for a support chatbot to answer questions from. ` +
    `Judge ONLY whether this reads as coherent, genuine document content — not whether it's well-written or ` +
    `complete. Answer "valid": false only if it looks like a broken extraction: garbled/nonsense character runs, ` +
    `mostly repeated symbols, an encoding-artifact wall of text, or clearly not real content (e.g. the file's own ` +
    `internal binary structure leaking through as text). A short, sparse, or informal document is still "valid": true ` +
    `if a person could read and understand it.\n\n` +
    `Respond with ONLY a JSON object, no other text: {"valid": true or false, "reason": "one short sentence"}\n\n` +
    `--- Extracted text sample ---\n${sample}`

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.openaiApiKey}`, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(env.aiRequestTimeoutMs),
      body: JSON.stringify({
        model: env.openaiModel,
        max_tokens: 150,
        temperature: 0,
        messages: [{ role: "user", content: prompt }],
      }),
    })

    if (!res.ok) {
      const bodyText = await res.text().catch(() => "")
      console.error(`[documentQualityCheck] llmQualityCheck: OpenAI request failed (${res.status}): ${bodyText.slice(0, 300)}`)
      // A failed quality-check call is not itself a reason to reject the
      // document — the heuristic pass already ran; this is a bonus check.
      return { ok: true }
    }

    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] }
    const raw = data.choices?.[0]?.message?.content ?? ""
    console.log(`[documentQualityCheck] llmQualityCheck: model response received (length=${raw.length})`)

    const verdict = parseVerdict(raw)
    if (!verdict) {
      console.error("[documentQualityCheck] llmQualityCheck: could not parse a verdict, treating as pass")
      return { ok: true }
    }

    console.log(`[documentQualityCheck] llmQualityCheck: DONE fileName="${fileName}" valid=${verdict.valid} reason="${verdict.reason}"`)
    if (!verdict.valid) {
      return { ok: false, reason: verdict.reason || "The extracted content doesn't look like valid document text." }
    }
    return { ok: true }
  } catch (err) {
    console.error(`[documentQualityCheck] llmQualityCheck: FAILED fileName="${fileName}"`, err)
    // Network/timeout error talking to OpenAI — same reasoning as the
    // !res.ok branch above: don't block the upload over the bonus check
    // itself failing.
    return { ok: true }
  }
}

// Runs both passes in order — the free heuristic first (can reject without
// ever calling OpenAI), then the LLM check only if the heuristic passed.
export async function verifyExtractedText(text: string, fileName: string, fileType: string): Promise<QualityCheckResult> {
  console.log(`[documentQualityCheck] verifyExtractedText: START fileName="${fileName}" fileType=${fileType} length=${text.length}`)
  const heuristic = heuristicQualityCheck(text)
  if (!heuristic.ok) {
    console.error(`[documentQualityCheck] verifyExtractedText: REJECTED by heuristic check: ${heuristic.reason}`)
    return heuristic
  }

  const llmResult = await llmQualityCheck(text, fileName, fileType)
  if (!llmResult.ok) {
    console.error(`[documentQualityCheck] verifyExtractedText: REJECTED by LLM check: ${llmResult.reason}`)
    return llmResult
  }

  console.log(`[documentQualityCheck] verifyExtractedText: PASSED fileName="${fileName}"`)
  return { ok: true }
}
