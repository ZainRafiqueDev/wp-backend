import { describe, expect, it, vi } from "vitest"

const QUERY_VECTOR = Array.from({ length: 1536 }, (_, index) => (index === 0 ? 1 : 0))
const OTHER_VECTOR = Array.from({ length: 1536 }, (_, index) => (index === 1 ? 1 : 0))

vi.mock("../../src/services/embeddings.service.js", () => ({
  embedTexts: vi.fn(async () => [QUERY_VECTOR]),
  toPgVectorLiteral: (embedding: number[]) => `[${embedding.join(",")}]`,
  activeEmbeddingIdentity: () => ({ model: "text-embedding-3-small", dim: 1536 }),
}))

// This test asserts fusion/tenant-isolation, not the WP-3.2 rerank stage —
// mock the rerank LLM call out (real provider keys are configured in this
// environment's .env) so it never makes a real network call here.
// Returning null makes rerankChunks fall back to the fused order unchanged.
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

async function insertReadyChunk(chatbotId: string, fileName: string, content: string, embedding: number[]): Promise<void> {
  const doc = await pool!.query<{ id: string }>(
    `insert into chatbot_documents (chatbot_id, file_name, file_type, file_size, status, chunk_count)
     values ($1, $2, 'txt', $3, 'ready', 1) returning id`,
    [chatbotId, fileName, content.length],
  )
  await pool!.query(
    `insert into chatbot_document_chunks
       (document_id, chatbot_id, content, embedding, content_tsv, source_type, embedding_model, embedding_dim)
     values ($1, $2, $3, $4::vector, to_tsvector('simple', $3), 'document', 'text-embedding-3-small', 1536)`,
    [doc.rows[0].id, chatbotId, content, vectorLiteral(embedding)],
  )
}

describe("WP-2.3 hybrid retrieval", () => {
  it("hits an exact SKU lexically, a synonym via vector, and never another tenant", async () => {
    const a = await seedOwnedChatbot("hyb-a")
    const b = await seedOwnedChatbot("hyb-b")

    await insertReadyChunk(a.chatbotId, "parts.txt", "Replacement filter part SKU-99XZ ships next day.", OTHER_VECTOR)
    await insertReadyChunk(a.chatbotId, "warranty.txt", "Automobile warranty covers the engine for one year.", QUERY_VECTOR)
    await insertReadyChunk(b.chatbotId, "secret.txt", "Tenant B confidential SKU-99XZ price list.", QUERY_VECTOR)

    const skuPages = await lookupRelevantDocumentChunks(a.chatbotId, "SKU-99XZ")
    expect(skuPages.some((page) => page.text.includes("SKU-99XZ"))).toBe(true)
    expect(skuPages.some((page) => page.text.includes("Tenant B"))).toBe(false)
    expect(skuPages.some((page) => page.title === "secret.txt")).toBe(false)

    const synonymPages = await lookupRelevantDocumentChunks(a.chatbotId, "car engine coverage")
    expect(synonymPages.some((page) => page.text.toLowerCase().includes("automobile warranty"))).toBe(true)
    expect(synonymPages.some((page) => page.text.includes("Tenant B"))).toBe(false)

    const foreign = await lookupRelevantDocumentChunks(b.chatbotId, "SKU-99XZ")
    expect(foreign.every((page) => page.text.includes("Tenant B"))).toBe(true)
    expect(foreign.some((page) => page.title === "parts.txt")).toBe(false)
  })
})
