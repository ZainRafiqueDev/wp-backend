import type { CrawledPage } from "../../src/lib/crawler/crawl.js"

// CS-17 (B09-001, B09-018): deterministic stand-in for lib/ai.ts's
// answerQuestion, for integration tests that used to send real chat turns to
// paid providers. Use inside a vi.mock factory:
//
//   vi.mock("../../src/lib/ai.js", async (importOriginal) => {
//     const actual = await importOriginal<typeof import("../../src/lib/ai.js")>()
//     const { fakeAnswerQuestion } = await import("../helpers/fakeAi.js")
//     return { ...actual, answerQuestion: vi.fn(fakeAnswerQuestion), completeCheaply: vi.fn(async () => null) }
//   })
//
// The reply is a pure function of the prompt pages, so tests can assert on
// exactly what the model was given (e.g. the attachment notice) and on cache
// behaviour (the reply names any attached files, so a cache leak between
// conversations shows up as the wrong file name in the other visitor's reply).
export const FAKE_AI_ANSWER = "Deterministic test answer."

export async function fakeAnswerQuestion(_chatbotName: string, pages: CrawledPage[]): Promise<string> {
  const attachmentNotices = pages.filter((p) => p.path === "attachment:notice")
  if (attachmentNotices.length === 0) return FAKE_AI_ANSWER
  const named = attachmentNotices.map((p) => /attached (?:a file|these files): ([^.]+(?:\.[a-z0-9]+)?)/i.exec(p.text)?.[1] ?? "")
  return `${FAKE_AI_ANSWER} The team will review ${named.join(", ")}.`
}

/**
 * Deterministic embedding: hashed bag of lower-cased words, L2-normalised, so
 * texts that share words are closer than texts that do not. Dimension follows
 * EMBEDDING_DIM (vitest.config.ts sets 1536).
 */
export function fakeEmbedding(text: string, dim = Number(process.env.EMBEDDING_DIM || 1536)): number[] {
  const vector = new Array<number>(dim).fill(0)
  for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    let h = 2166136261
    for (let i = 0; i < word.length; i++) h = Math.imul(h ^ word.charCodeAt(i), 16777619)
    vector[(h >>> 0) % dim] += 1
  }
  const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0))
  if (norm === 0) {
    vector[0] = 1
    return vector
  }
  return vector.map((v) => v / norm)
}

/** Drop-in for @langchain/openai's OpenAIEmbeddings (no network). */
export class FakeOpenAIEmbeddings {
  constructor(_fields?: unknown) {}
  async embedDocuments(texts: string[]): Promise<number[][]> {
    return texts.map((t) => fakeEmbedding(t))
  }
  async embedQuery(text: string): Promise<number[]> {
    return fakeEmbedding(text)
  }
}
