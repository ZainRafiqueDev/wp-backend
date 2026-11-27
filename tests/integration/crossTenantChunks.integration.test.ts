import { describe, expect, it, vi } from "vitest"

const QUERY_VECTOR = Array.from({ length: 1536 }, (_, index) => (index === 0 ? 1 : 0))
const OTHER_VECTOR = Array.from({ length: 1536 }, (_, index) => (index === 1 ? 1 : 0))

vi.mock("../../src/services/embeddings.service.js", () => ({
  embedTexts: vi.fn(async () => [QUERY_VECTOR]),
  toPgVectorLiteral: (embedding: number[]) => `[${embedding.join(",")}]`,
  activeEmbeddingIdentity: () => ({ model: "text-embedding-3-small", dim: 1536 }),
}))

// Mock the WP-3.2 rerank LLM call out — real provider keys are configured in
// this environment's .env, and this test is about tenant isolation, not
// reranking. Returning null falls back to the fused order unchanged.
vi.mock("../../src/lib/ai.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/ai.js")>()
  return { ...actual, completeCheaply: vi.fn(async () => null) }
})

const { pool } = await import("../../src/lib/db.js")
const { lookupRelevantDocumentChunks } = await import("../../src/services/documentIngestion.service.js")
const { seedOwnedChatbot } = await import("../helpers/seedTenant.js")

function vectorLiteral(values: number[]): string {
  return `[${values.join(",")}]`
}

describe("WP-1.7 document chunk SQL isolation", () => {
  it("lookupRelevantDocumentChunks never returns another chatbot's chunks", async () => {
    const a = await seedOwnedChatbot("xt-chunk-a")
    const b = await seedOwnedChatbot("xt-chunk-b")

    const docA = await pool!.query<{ id: string }>(
      `insert into chatbot_documents (chatbot_id, file_name, file_type, file_size, status, chunk_count)
       values ($1, 'a-secret.txt', 'txt', 24, 'ready', 1) returning id`,
      [a.chatbotId],
    )
    const docB = await pool!.query<{ id: string }>(
      `insert into chatbot_documents (chatbot_id, file_name, file_type, file_size, status, chunk_count)
       values ($1, 'b-secret.txt', 'txt', 24, 'ready', 1) returning id`,
      [b.chatbotId],
    )
    await pool!.query(
      `insert into chatbot_document_chunks
         (document_id, chatbot_id, content, embedding, embedding_model, embedding_dim)
       values ($1, $2, 'tenant A secret pricing sheet', $3::vector, 'text-embedding-3-small', 1536),
              ($4, $5, 'tenant B secret pricing sheet', $6::vector, 'text-embedding-3-small', 1536)`,
      [
        docA.rows[0].id,
        a.chatbotId,
        vectorLiteral(QUERY_VECTOR),
        docB.rows[0].id,
        b.chatbotId,
        vectorLiteral(OTHER_VECTOR),
      ],
    )

    const sql = await pool!.query<{ chatbot_id: string; content: string }>(
      `select c.chatbot_id, c.content
       from chatbot_document_chunks c
       join chatbot_documents d on d.id = c.document_id
       where c.chatbot_id = $1 and c.embedding is not null and d.status = 'ready'
         and (c.embedding <=> $2::vector) <= 2
       order by c.embedding <=> $2::vector
       limit 5`,
      [a.chatbotId, vectorLiteral(QUERY_VECTOR)],
    )
    expect(sql.rows.every((row) => row.chatbot_id === a.chatbotId)).toBe(true)
    expect(sql.rows.some((row) => row.content.includes("tenant B"))).toBe(false)

    const pages = await lookupRelevantDocumentChunks(a.chatbotId, "what is the secret pricing")
    expect(pages.every((page) => page.text.includes("tenant A"))).toBe(true)
    expect(pages.some((page) => page.text.includes("tenant B"))).toBe(false)
    expect(pages.some((page) => page.title === "b-secret.txt")).toBe(false)
  })
})
