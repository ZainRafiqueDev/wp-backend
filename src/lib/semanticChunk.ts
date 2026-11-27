// WP-3.3 semantic chunker — replaces the old paragraph-boundary chunkText.ts.
//
// Input is plain extracted text (from PDF/DOCX/XLSX/TXT/MD/CSV — see
// documentParsing.ts), not necessarily markdown, so heading detection uses
// both a markdown heuristic (`# Heading`) and a plain-text one (a short
// line with no closing sentence punctuation, standing alone between blank
// lines). Tables are detected as blocks of consecutive delimiter-aligned
// lines (tabs, multiple pipes, or 3+-space column gaps) and are never split
// mid-row — an oversized table is split into its own dedicated chunks with
// the header row repeated and a [TABLE CONTINUES]/[TABLE CONTINUED] marker,
// per the master prompt's table-handling spec.
//
// Known, deliberate limitation: page_number is left null. pdf-parse (see
// documentParsing.ts) concatenates every page into one string with no page
// boundaries preserved, and reconstructing them requires overriding its
// internal pdf.js page-render callback — a fragile change to a currently
// working extraction path for a "nice to have" field. Flagged rather than
// faked.

export interface SemanticChunk {
  text: string
  heading: string | null
  section: string | null
  documentType: string
  tokenEstimate: number
  charCount: number
}

export interface ChunkingOptions {
  targetChunkSize?: number
  minChunkSize?: number
  maxChunkSize?: number
  overlapChars?: number
  documentType?: string
}

const DEFAULTS: Required<Omit<ChunkingOptions, "documentType">> = {
  targetChunkSize: 1200,
  minChunkSize: 200,
  maxChunkSize: 2000,
  overlapChars: 200,
}

type Block =
  | { kind: "heading"; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "table"; rows: string[] }

const MARKDOWN_HEADING = /^#{1,6}\s+(.+)$/
// A short, standalone line with no closing sentence punctuation — the
// common shape of a heading in text extracted from a PDF/DOCX where
// markdown markup doesn't survive extraction.
const PLAIN_HEADING = /^[^\n.;:,]{1,80}$/
const TABLE_LINE = /\t{1,}|(?:\s{3,})|(?: \| )|^\s*\|.*\|\s*$/

function looksLikeTableLine(line: string): boolean {
  if (!line.trim()) return false
  const delimiterHits = (line.match(TABLE_LINE) || []).length
  return delimiterHits >= 1 && line.trim().length > 0 && /\S+(?:\t|\s{3,}|\|)\S+/.test(line)
}

function splitIntoBlocks(text: string): Block[] {
  const lines = text.split("\n")
  const blocks: Block[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) {
      i++
      continue
    }

    // Table run: 2+ consecutive delimiter-aligned lines.
    if (looksLikeTableLine(line)) {
      const rows: string[] = []
      while (i < lines.length && looksLikeTableLine(lines[i])) {
        rows.push(lines[i])
        i++
      }
      if (rows.length >= 2) {
        blocks.push({ kind: "table", rows })
        continue
      }
      // A single stray delimiter-looking line isn't a real table — fall
      // through and treat it as prose below.
      i -= rows.length
    }

    // Heading: markdown form, or a short standalone line surrounded by
    // blank lines (previous emitted block boundary / start of doc, and the
    // next line is blank or the last line).
    const markdownMatch = line.match(MARKDOWN_HEADING)
    const prevBlank = i === 0 || !lines[i - 1]?.trim()
    const nextBlank = i === lines.length - 1 || !lines[i + 1]?.trim()
    if (markdownMatch) {
      blocks.push({ kind: "heading", text: markdownMatch[1].trim() })
      i++
      continue
    }
    if (prevBlank && nextBlank && PLAIN_HEADING.test(line.trim()) && line.trim().length > 0) {
      blocks.push({ kind: "heading", text: line.trim() })
      i++
      continue
    }

    // Paragraph: accumulate until a blank line, a heading, or a table run.
    const paraLines: string[] = [line]
    i++
    while (i < lines.length && lines[i].trim() && !looksLikeTableLine(lines[i])) {
      const isNextHeading =
        MARKDOWN_HEADING.test(lines[i]) ||
        (PLAIN_HEADING.test(lines[i].trim()) && (i === lines.length - 1 || !lines[i + 1]?.trim()) && !lines[i - 1]?.trim())
      if (isNextHeading) break
      paraLines.push(lines[i])
      i++
    }
    blocks.push({ kind: "paragraph", text: paraLines.join("\n").trim() })
  }

  return blocks
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

function tailOverlap(text: string, overlapChars: number): string {
  if (text.length <= overlapChars) return text
  // Break on a sentence/word boundary near the tail rather than mid-word.
  const tail = text.slice(-overlapChars)
  const spaceIdx = tail.indexOf(" ")
  return spaceIdx === -1 ? tail : tail.slice(spaceIdx + 1)
}

/** Splits an oversized table into row-based chunks, header repeated, never mid-row. */
function chunkTable(rows: string[], opts: Required<Omit<ChunkingOptions, "documentType">>): string[] {
  const header = rows[0]
  const full = rows.join("\n")
  if (full.length <= opts.maxChunkSize) return [full]

  const chunks: string[] = []
  let current: string[] = [header]
  let currentLen = header.length
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r]
    if (currentLen + row.length + 1 > opts.maxChunkSize && current.length > 1) {
      chunks.push(`${current.join("\n")}\n[TABLE CONTINUES]`)
      current = [header]
      currentLen = header.length
    }
    current.push(row)
    currentLen += row.length + 1
  }
  if (current.length > 1) chunks.push(current.join("\n"))

  return chunks.map((c, idx) => (idx === 0 ? c : `[TABLE CONTINUED]\n${c}`))
}

/**
 * Splits `text` into semantically-aware chunks: paragraph/heading/table
 * structure is preserved, tables are never split mid-row, chunks carry
 * their parent heading, and each chunk overlaps the tail of the previous
 * one so retrieval context isn't lost at a chunk boundary.
 */
export function semanticChunk(text: string, options: ChunkingOptions = {}): SemanticChunk[] {
  const opts = { ...DEFAULTS, ...options }
  const documentType = options.documentType || "general"
  const blocks = splitIntoBlocks(text)

  const chunks: SemanticChunk[] = []
  let currentHeading: string | null = null
  let buffer = ""
  let bufferHeading: string | null = null

  const flush = (): string => {
    const trimmed = buffer.trim()
    buffer = ""
    if (!trimmed) return ""
    chunks.push({
      text: trimmed,
      heading: bufferHeading,
      section: bufferHeading,
      documentType,
      tokenEstimate: estimateTokens(trimmed),
      charCount: trimmed.length,
    })
    return trimmed
  }

  for (const block of blocks) {
    if (block.kind === "heading") {
      // A heading starts a new topic — flush what's accumulated so far
      // rather than blending two sections into one chunk.
      flush()
      currentHeading = block.text
      continue
    }

    if (block.kind === "table") {
      flush()
      const tableChunks = chunkTable(block.rows, opts)
      for (const t of tableChunks) {
        chunks.push({
          text: t,
          heading: currentHeading,
          section: currentHeading,
          documentType,
          tokenEstimate: estimateTokens(t),
          charCount: t.length,
        })
      }
      continue
    }

    // Paragraph block.
    if (!buffer) bufferHeading = currentHeading
    const candidate = buffer ? `${buffer}\n\n${block.text}` : block.text

    if (candidate.length > opts.maxChunkSize && block.text.length > opts.maxChunkSize) {
      // A single paragraph longer than the hard ceiling (rare — a dense
      // data dump with no blank lines) — hard-slice it, still overlapped.
      flush()
      for (let i = 0; i < block.text.length; i += opts.targetChunkSize - opts.overlapChars) {
        const slice = block.text.slice(i, i + opts.targetChunkSize)
        chunks.push({
          text: slice,
          heading: currentHeading,
          section: currentHeading,
          documentType,
          tokenEstimate: estimateTokens(slice),
          charCount: slice.length,
        })
      }
      continue
    }

    if (candidate.length > opts.targetChunkSize && buffer) {
      const flushed = flush()
      const overlap = tailOverlap(flushed, opts.overlapChars)
      bufferHeading = currentHeading
      buffer = overlap ? `${overlap}\n\n${block.text}` : block.text
    } else {
      buffer = candidate
    }
  }
  flush()

  // Enforce a minimum size by merging orphan tail chunks (from the same
  // heading/section) into their predecessor rather than emitting tiny
  // fragments.
  const merged: SemanticChunk[] = []
  for (const chunk of chunks) {
    const prev = merged[merged.length - 1]
    if (
      prev &&
      chunk.charCount < opts.minChunkSize &&
      prev.heading === chunk.heading &&
      prev.charCount + chunk.charCount <= opts.maxChunkSize
    ) {
      prev.text = `${prev.text}\n\n${chunk.text}`
      prev.charCount = prev.text.length
      prev.tokenEstimate = estimateTokens(prev.text)
      continue
    }
    merged.push({ ...chunk })
  }

  return merged
}

/** Builds the text actually sent to the embedding model — heading context
 * improves retrieval accuracy without changing what's stored/shown as the
 * chunk's own content. */
export function embeddingTextFor(chunk: SemanticChunk): string {
  return chunk.heading ? `[Section: ${chunk.heading}]\n\n${chunk.text}` : chunk.text
}
