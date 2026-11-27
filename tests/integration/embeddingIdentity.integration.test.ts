import { describe, expect, it, vi } from "vitest"

const QUERY_VECTOR = Array.from({ length: 1536 }, (_, index) => (index === 0 ? 1 : 0))

vi.mock("../../src/services/embeddings.service.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/services/embeddings.service.js")>(
    "../../src/services/embeddings.service.js",
  )
  return {
    ...actual,
    embedTexts: vi.fn(async () => [QUERY_VECTOR]),
    toPgVectorLiteral: (embedding: number[]) => `[${embedding.join(",")}]`,
  }
})

// Mock the WP-3.2 rerank LLM call out — real provider keys are configured in
// this environment's .env, and this test is about embedding-identity
// filtering, not reranking. Returning null falls back to the fused order.
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

describe("WP-2.4 embedding identity coexistence", () => {
  it("does not mix a previous embedding generation into vector lookup", async () => {
    const tenant = await seedOwnedChatbot("emb-ident")
    const doc = await pool!.query<{ id: string }>(
      `insert into chatbot_documents (chatbot_id, file_name, file_type, file_size, status, chunk_count)
       values ($1, 'mixed.txt', 'txt', 40, 'ready', 2) returning id`,
      [tenant.chatbotId],
    )

    await pool!.query(
      `insert into chatbot_document_chunks
         (document_id, chatbot_id, content, embedding, embedding_model, embedding_dim)
       values
         ($1, $2, 'active generation automobile warranty', $3::vector, 'text-embedding-3-small', 1536),
         ($1, $2, 'LEGACY_ONLY_CHUNK from a previous model', $3::vector, 'text-embedding-ada-002', 1536)`,
      [doc.rows[0].id, tenant.chatbotId, vectorLiteral(QUERY_VECTOR)],
    )

    const pages = await lookupRelevantDocumentChunks(tenant.chatbotId, "car engine coverage")
    expect(pages.some((page) => page.text.includes("automobile warranty"))).toBe(true)
    expect(pages.some((page) => page.text.includes("LEGACY_ONLY_CHUNK"))).toBe(false)
  })
})
