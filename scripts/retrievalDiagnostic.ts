/**
 * Scratch diagnostic harness for semantic/synonym retrieval failures.
 * Not production code. Run: npx tsx scripts/retrievalDiagnostic.ts
 *
 * Uses real local Postgres + the real answering pipeline. No mocks.
 */
import "dotenv/config"

import { writeFileSync } from "node:fs"
import { resolve } from "node:path"

import { answerChatbotQuestion, sourcesToPages } from "../src/lib/answerChatbotQuestion.js"
import { defaultFallbackMessage, type ChatbotSource } from "../src/lib/chatbot.js"
import { pool } from "../src/lib/db.js"
import { hasRelevantContent } from "../src/lib/relevance.js"
import { verifyGroundedClaims } from "../src/lib/groundingCheck.js"
import { lookupRelevantDocumentChunks } from "../src/services/documentIngestion.service.js"
import { getEntitlementForChatbot } from "../src/services/billing.service.js"
import { embedTexts, toPgVectorLiteral } from "../src/services/embeddings.service.js"
import { redis } from "../src/lib/redis.js"

const CHATBOT_ID = process.env.DIAG_CHATBOT_ID || "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"

const QUERIES = [
  { id: 1, q: "web development", expect: "positive" as const },
  { id: 2, q: "web dev", expect: "positive" as const },
  { id: 3, q: "website development", expect: "positive" as const },
  { id: 4, q: "do you build websites?", expect: "positive" as const },
  { id: 5, q: "do you make sites?", expect: "positive" as const },
  { id: 6, q: "what web services do you provide?", expect: "positive" as const },
  { id: 7, q: "what is the weather tomorrow?", expect: "negative" as const },
  { id: 8, q: "who won the world cup in 2018?", expect: "negative" as const },
  // Step 9 extras
  { id: 9, q: "What programming languages do your web developers use?", expect: "in_scope_maybe_insufficient" as const },
]

const STOPWORDS = new Set([
  "what", "when", "where", "which", "who", "whom", "whose", "why", "how",
  "does", "did", "do", "is", "are", "was", "were", "will", "would", "could",
  "should", "have", "has", "had", "with", "this", "that", "these", "those",
  "your", "you", "the", "and", "for", "about", "tell", "give", "please",
  "can", "there", "here", "from", "into", "than", "then",
])

function meaningfulWords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 3 && !STOPWORDS.has(word))
}

function preview(text: string, n = 180): string {
  const t = text.replace(/\s+/g, " ").trim()
  return t.length <= n ? t : `${t.slice(0, n)}…`
}

function looksLikeFallback(text: string, chatbotName: string): boolean {
  const fb = defaultFallbackMessage(chatbotName).toLowerCase()
  const lower = text.toLowerCase()
  return (
    lower === fb ||
    lower.includes("i can only help with questions about") ||
    lower.includes("outside what you can help") ||
    lower.includes("reach out to their team")
  )
}

function looksLikeInsufficient(text: string): boolean {
  const lower = text.toLowerCase()
  return (
    lower.includes("don't have that information") ||
    lower.includes("do not have that information") ||
    lower.includes("don't have enough") ||
    lower.includes("not sure") ||
    lower.includes("i don't have") ||
    lower.includes("isn't covered") ||
    lower.includes("is not covered") ||
    lower.includes("no information")
  )
}

type Trace = Record<string, unknown>

async function loadChatbot(id: string) {
  if (!pool) throw new Error("No database pool — set DATABASE_URL")
  const { rows } = await pool.query(
    `select id, name, sources, fallback_message, preferred_model, status
     from chatbots where id = $1`,
    [id],
  )
  if (!rows[0]) throw new Error(`Chatbot ${id} not found`)
  const row = rows[0]
  const sources = (Array.isArray(row.sources) ? row.sources : []) as ChatbotSource[]
  return {
    id: row.id as string,
    name: row.name as string,
    sources,
    fallbackMessage: (row.fallback_message as string) || defaultFallbackMessage(row.name),
    preferredModel: row.preferred_model as "anthropic" | "openai" | "gemini" | null,
    status: row.status as string,
  }
}

async function pgvectorTop5(chatbotId: string, question: string) {
  if (!pool) return { embeddingModel: null, candidates: [] as unknown[] }
  const embeddings = await embedTexts([question], { chatbotId, purpose: "document_query" })
  const embedding = embeddings[0]
  if (!embedding) return { embeddingModel: null, candidates: [] as unknown[], note: "no embedding available" }

  const { rows } = await pool.query<{
    id: string
    content: string
    file_name: string
    distance: number
  }>(
    `select c.id, c.content, d.file_name, (c.embedding <=> $2::vector) as distance
     from chatbot_document_chunks c
     join chatbot_documents d on d.id = c.document_id
     where c.chatbot_id = $1 and c.embedding is not null and d.status = 'ready'
     order by c.embedding <=> $2::vector
     limit 5`,
    [chatbotId, toPgVectorLiteral(embedding)],
  )

  return {
    embeddingModel: process.env.PRODUCT_EMBEDDING_MODEL || "text-embedding-3-small",
    note: rows.length === 0 ? "no document chunks for this chatbot (crawled-page path only)" : undefined,
    candidates: rows.map((r) => ({
      chunkId: r.id,
      fileName: r.file_name,
      distance: Number(r.distance),
      // cosine distance from pgvector <=> on vector; lower is closer
      preview: preview(r.content, 120),
    })),
  }
}

async function runOne(chatbot: Awaited<ReturnType<typeof loadChatbot>>, question: string, label: string): Promise<Trace> {
  const pages = sourcesToPages(chatbot.sources)
  const qWords = meaningfulWords(question)
  const matchingPages: { path: string; matchedWords: string[] }[] = []
  for (const page of pages) {
    const pageText = `${page.title} ${page.text}`.toLowerCase()
    const matched = qWords.filter((w) => pageText.includes(w))
    if (matched.length) matchingPages.push({ path: page.path, matchedWords: matched })
  }

  const entitlement = await getEntitlementForChatbot(chatbot.id)
  const documentPages = entitlement.documentIngestion
    ? await lookupRelevantDocumentChunks(chatbot.id, question)
    : []

  const relevancePages = [...pages, ...documentPages]
  const relevant = hasRelevantContent(question, relevancePages)

  const vector = await pgvectorTop5(chatbot.id, question)

  // Bust answer/relevance caches so each run is live.
  try {
    const keys = await redis.keys(`*:${chatbot.id}:*`)
    // Only wipe answer/relevance keys containing a hash of this question if present
    for (const k of keys) {
      if (k.includes("answer:") || k.includes("relevance:")) {
        // leave pages cache; delete answer+relevance for fresh gate decision
        if (k.startsWith("answer:") || k.startsWith("relevance:") || k.includes(":answer:") || k.includes(":relevance:")) {
          await redis.del(k)
        }
      }
    }
  } catch {
    // non-fatal
  }

  const started = Date.now()
  const answer = await answerChatbotQuestion(
    chatbot.id,
    chatbot.name,
    chatbot.sources,
    question,
    [],
    chatbot.fallbackMessage,
    [],
    undefined,
    chatbot.preferredModel,
  )
  const elapsedMs = Date.now() - started

  const groundingContext = [...pages, ...documentPages].map((p) => p.text).join("\n")
  const grounding = answer.aiGenerated ? verifyGroundedClaims(answer.text, groundingContext) : { ok: true, failedClaims: [] as string[], skipped: true }

  const isFallback = looksLikeFallback(answer.text, chatbot.name)
  const isInsufficient = looksLikeInsufficient(answer.text)

  const llmScopeDecline =
    /outside what (i|you) can help|unrelated|not about (this|the) site|can only help with questions about/i.test(
      answer.text,
    )

  let classification: string[] = []
  if (label === "negative") {
    if ((!answer.aiGenerated && isFallback) || llmScopeDecline) {
      classification = ["negative_control_ok"]
    } else if (answer.aiGenerated && !isFallback && !llmScopeDecline) {
      classification = ["A. Scope classification failure"] // answered out-of-scope
    } else {
      classification = ["negative_control_ok"]
    }
  } else if (label === "in_scope_maybe_insufficient") {
    if (answer.aiGenerated && !isFallback && !isInsufficient) {
      // May be fabricating if languages aren't in source — check later
      classification = ["needs_manual_hallucination_check"]
    } else if (isInsufficient || isFallback) {
      classification = ["E. Prompt/answer-generation (declined) or A/D — acceptable if no fabrication"]
    }
  } else {
    // positive — expect a grounded on-topic answer
    if (!relevant) {
      classification.push("A. Scope classification failure (relevance keyword gate)")
      classification.push("B. Retrieval failure (never reached AI because gate blocked)")
    }
    if (relevant && isFallback && !answer.aiGenerated) {
      classification.push("A. Scope/relevance path returned fallback without AI")
    }
    if (relevant && answer.aiGenerated && isFallback) {
      classification.push("E. Prompt/answer-generation failure (model gave scope refusal)")
    }
    if (relevant && !answer.aiGenerated && answer.gateReason) {
      classification.push(`gateReason=${answer.gateReason}`)
    }
    if (answer.aiGenerated && !isFallback && grounding.ok === false) {
      classification.push("D. Grounding validation failure")
    }
    if (answer.aiGenerated && !isFallback && grounding.ok !== false) {
      classification = ["PASS"]
    }
    if (!relevant && isFallback) {
      // already classified
    }
    if (classification.length === 0) {
      classification = ["H. Unclear — inspect trace"]
    }
  }

  return {
    originalQuery: question,
    expect: label,
    conversationContext: [],
    transformedQuery: null,
    questionMeaningfulWords: qWords,
    scopeDecision: {
      relevanceGate: relevant ? "IN_SCOPE_KEYWORD_OVERLAP" : "OUT_OF_SCOPE_NO_KEYWORD_OVERLAP",
      note: "Pre-LLM gate is hasRelevantContent() — keyword overlap, not semantic scope",
    },
    matchingPages: matchingPages.slice(0, 5),
    documentIngestionEnabled: entitlement.documentIngestion,
    documentChunksInjected: documentPages.map((p) => ({ title: p.title, preview: preview(p.text, 100) })),
    pgvector: vector,
    similarityThreshold: "none — document path uses ORDER BY distance LIMIT K only; crawled pages are not retrieved via pgvector",
    groundingCheck: grounding,
    finalAnswer: {
      text: answer.text,
      aiGenerated: answer.aiGenerated,
      gateReason: answer.gateReason ?? null,
      looksLikeFallback: isFallback,
      looksLikeInsufficientInfo: isInsufficient,
    },
    elapsedMs,
    failureClassification: classification,
  }
}

async function main() {
  const phase = process.env.DIAG_PHASE || "before"
  const chatbot = await loadChatbot(CHATBOT_ID)

  const webDevSources = chatbot.sources.filter(
    (s) =>
      (s.label || "").toLowerCase().includes("web-development") ||
      (s.content || "").toLowerCase().includes("web development"),
  )

  const sourceProof = {
    chatbotId: chatbot.id,
    chatbotName: chatbot.name,
    status: chatbot.status,
    sourceCount: chatbot.sources.length,
    webDevelopmentRelatedSources: webDevSources.map((s) => ({
      label: s.label,
      url: s.url,
      contentPreview: preview(s.content || "", 240),
    })),
  }

  console.log(`[diagnostic] phase=${phase} chatbot=${chatbot.name} (${chatbot.id}) sources=${chatbot.sources.length}`)
  console.log(`[diagnostic] web-dev related sources: ${webDevSources.length}`)

  const traces: Trace[] = []
  for (const item of QUERIES) {
    console.log(`[diagnostic] running #${item.id}: ${item.q}`)
    const trace = await runOne(chatbot, item.q, item.expect)
    traces.push(trace)
    console.log(
      `  → relevance=${(trace.scopeDecision as { relevanceGate: string }).relevanceGate} ai=${(trace.finalAnswer as { aiGenerated: boolean }).aiGenerated} class=${(trace.failureClassification as string[]).join("|")}`,
    )
    console.log(`  → answer: ${preview(String((trace.finalAnswer as { text: string }).text), 140)}`)
  }

  const out = {
    phase,
    generatedAt: new Date().toISOString(),
    sourceProof,
    pipelineNote:
      "Crawled website pages are NOT retrieved via pgvector — they are converted to pages and keyword-gated, then stuffed into the LLM prompt. pgvector is only for uploaded document chunks (paid plans) and product catalog.",
    traces,
  }

  const outPath = resolve(process.cwd(), `scripts/retrieval-diagnostic-${phase}.json`)
  writeFileSync(outPath, JSON.stringify(out, null, 2), "utf8")
  console.log(`[diagnostic] wrote ${outPath}`)

  await redis.quit().catch(() => {})
  if (pool) await pool.end().catch(() => {})
}

main().catch(async (err) => {
  console.error(err)
  await redis.quit().catch(() => {})
  if (pool) await pool.end().catch(() => {})
  process.exit(1)
})
