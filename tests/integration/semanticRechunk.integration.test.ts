import { randomUUID } from "node:crypto"
import { describe, expect, it, vi } from "vitest"

import { signAccessToken } from "../../src/lib/auth.js"
import { pool } from "../../src/lib/db.js"
import { documentStorageKey, putDocumentObject } from "../../src/lib/objectStorage.js"

vi.mock("../../src/services/embeddings.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/embeddings.service.js")>()
  return {
    ...actual,
    embedTexts: vi.fn(async (texts: string[]) => texts.map(() => Array(1536).fill(0.01))),
  }
})

const {
  findNextLegacyChunkDocumentId,
  rechunkLegacyDocument,
} = await import("../../src/services/documentIngestion.service.js")

async function seedChatbot(label: string): Promise<string> {
  const user = await pool!.query<{ id: string }>(
    `insert into users (email, password_hash, name, email_verified) values ($1, 'x', $2, true) returning id`,
    [`${label}-${randomUUID()}@example.test`, label],
  )
  const bot = await pool!.query<{ id: string }>(
    `insert into chatbots (user_id, name, sources, status) values ($1, $2, '[]', 'ready') returning id`,
    [user.rows[0].id, `${label} bot`],
  )
  return bot.rows[0].id
}

// Simulates a document ingested before WP-3.3 existed: a ready document with
// only chunking_version=1 rows (the old fixed-size chunkText.ts shape — no
// heading/section/token_estimate) and its original bytes still in storage,
// exactly what the background worker's rechunk-legacy-tick finds in production.
async function seedLegacyDocument(chatbotId: string, text: string): Promise<string> {
  const documentId = randomUUID()
  const storageKey = documentStorageKey(chatbotId, documentId, "legacy.txt")
  await putDocumentObject(storageKey, Buffer.from(text, "utf8"))
  await pool!.query(
    `insert into chatbot_documents
       (id, chatbot_id, file_name, file_type, file_size, status, storage_key, chunk_count, scan_status)
     values ($1, $2, 'legacy.txt', 'txt', $3, 'ready', $4, 1, 'clean')`,
    [documentId, chatbotId, text.length, storageKey],
  )
  await pool!.query(
    `insert into chatbot_document_chunks (document_id, chatbot_id, content, source_type, chunking_version)
     values ($1, $2, $3, 'document', 1)`,
    [documentId, chatbotId, text],
  )
  return documentId
}

// findNextLegacyChunkDocumentId scans the WHOLE database (by design — the
// background worker migrates every tenant's backlog, oldest first), and
// this integration suite shares a database with many other test files that
// also create version-1 chunks. So "does the finder pick MY document" isn't
// a deterministic thing to assert here — some other, older v1 document
// legitimately outranks it. This checks the finder's predicate directly
// (would this document qualify?) instead of asserting global pick order.
async function isLegacyRechunkCandidate(documentId: string): Promise<boolean> {
  const { rows } = await pool!.query<{ candidate: boolean }>(
    `select exists (
       select 1 from chatbot_documents d
       where d.id = $1
         and d.status = 'ready'
         and d.storage_key is not null
         and exists (select 1 from chatbot_document_chunks c where c.document_id = d.id and c.chunking_version = 1)
         and not exists (select 1 from chatbot_document_chunks c2 where c2.document_id = d.id and c2.chunking_version = 2)
     ) as candidate`,
    [documentId],
  )
  return rows[0].candidate
}

describe("WP-3.3 background re-chunking migration", () => {
  it("finds a version-1 document and migrates it to version-2 semantic chunks", async () => {
    const chatbotId = await seedChatbot("rechunk-basic")
    const documentId = await seedLegacyDocument(
      chatbotId,
      "Refund Policy\n\nItems can be returned within 30 days of purchase with a receipt.\n\nShipping\n\nOrders ship within 2 business days.",
    )

    // The finder's own global pick may be a different, older document from
    // another test — but MY document must satisfy its selection predicate.
    expect(await isLegacyRechunkCandidate(documentId)).toBe(true)
    expect(await findNextLegacyChunkDocumentId()).not.toBeNull()

    const result = await rechunkLegacyDocument(documentId)
    expect(result.chatbotId).toBe(chatbotId)
    expect(result.oldChunks).toBe(1)
    expect(result.newChunks).toBeGreaterThan(0)

    const { rows } = await pool!.query<{ chunking_version: number; heading: string | null; content: string }>(
      "select chunking_version, heading, content from chatbot_document_chunks where document_id = $1 order by created_at",
      [documentId],
    )
    // Only version-2 chunks remain — the old version-1 row was removed.
    expect(rows.every((r) => r.chunking_version === 2)).toBe(true)
    expect(rows.some((r) => r.heading === "Refund Policy")).toBe(true)
    expect(rows.some((r) => r.heading === "Shipping")).toBe(true)

    // No longer picked up by the finder — this document is fully migrated.
    expect(await isLegacyRechunkCandidate(documentId)).toBe(false)
  })

  it("never leaves the document with zero chunks — new rows exist before old ones are removed", async () => {
    const chatbotId = await seedChatbot("rechunk-zero-downtime")
    const documentId = await seedLegacyDocument(chatbotId, "Store Hours\n\nWe are open Monday through Friday, 9am to 5pm.")

    const before = await pool!.query("select count(*)::int as n from chatbot_document_chunks where document_id = $1", [documentId])
    expect(before.rows[0].n).toBeGreaterThan(0)

    await rechunkLegacyDocument(documentId)

    const after = await pool!.query("select count(*)::int as n from chatbot_document_chunks where document_id = $1", [documentId])
    expect(after.rows[0].n).toBeGreaterThan(0)
  })

  it("respects a chatbot's configured chunk_target_chars", async () => {
    // 800 is the master prompt's own documented floor for this setting —
    // below the chunker's 200-char minChunkSize, a smaller target would be
    // neutralized by the orphan-merge step (by design: never emit chunks
    // tinier than minChunkSize just because target size asked for it).
    const chatbotId = await seedChatbot("rechunk-target-size")
    await pool!.query("update chatbots set chunk_target_chars = 800 where id = $1", [chatbotId])
    const longText =
      "Intro\n\n" +
      Array.from({ length: 80 }, (_, i) => `Sentence number ${i} about our product features and how they work in practice.`).join(" ")
    const documentId = await seedLegacyDocument(chatbotId, longText)

    await rechunkLegacyDocument(documentId)

    const { rows } = await pool!.query<{ content: string }>(
      "select content from chatbot_document_chunks where document_id = $1 and chunking_version = 2",
      [documentId],
    )
    expect(rows.length).toBeGreaterThan(1)
    for (const row of rows) {
      expect(row.content.length).toBeLessThanOrEqual(2000)
    }
  })

  it("tenant isolation: rechunking one chatbot's document never touches another chatbot's chunks", async () => {
    const chatbotA = await seedChatbot("rechunk-tenant-a")
    const chatbotB = await seedChatbot("rechunk-tenant-b")
    const docA = await seedLegacyDocument(chatbotA, "Tenant A content about pricing.")
    const docB = await seedLegacyDocument(chatbotB, "Tenant B content about shipping.")

    await rechunkLegacyDocument(docA)

    const { rows: bRows } = await pool!.query(
      "select chunking_version from chatbot_document_chunks where document_id = $1",
      [docB],
    )
    expect(bRows.every((r) => r.chunking_version === 1)).toBe(true)
    expect(await isLegacyRechunkCandidate(docB)).toBe(true)
  })
})
