import { createHash, randomUUID } from "node:crypto"

import { embeddingTextFor, semanticChunk } from "../lib/semanticChunk.js"
import { verifyAccessToken } from "../lib/auth.js"
import { bumpChatbotCacheVersion } from "../lib/cache.js"
import { requireOwnedChatbotId } from "../lib/chatbotOwnership.js"
import type { CrawledPage } from "../lib/crawler/crawl.js"
import { pool } from "../lib/db.js"
import { setTenantContext, runWithTenantContext } from "../lib/tenantContext.js"
import { detectDocumentType, extractText, extractTextWithMethod } from "../lib/documentParsing.js"
import { verifyExtractedText } from "../lib/documentQualityCheck.js"
import { AppError } from "../lib/errors.js"
import {
  assertChatbotBytes,
  assertChatbotChunks,
  assertDocumentChunks,
  assertDocumentCount,
  assertFileBytes,
  enforceIngestCap,
  resolveIngestCapsForPlan,
  type IngestCaps,
} from "../lib/ingestCaps.js"
import type { DocumentIngestionConfig } from "../lib/plans.js"
import { resolveTenantContext } from "../lib/tenancy.js"
import { incrementIngestMetric, observeIngestProcessingAge } from "../lib/ingestMetrics.js"
import { log } from "../lib/logger.js"
import { enqueueDocumentIngestJob } from "../lib/ingestQueue.js"
import {
  MALWARE_DENIED_MESSAGE,
  MalwareScanUnavailableError,
  scanDocumentBytes,
  type DocumentScanStatus,
} from "./malwareScan.service.js"
import {
  deleteDocumentObject,
  documentStorageKey,
  getDocumentObject,
  putDocumentObject,
} from "../lib/objectStorage.js"
import { env } from "../env.js"
import {
  fuseLexicalAndVector,
  incrementRetrievalMetric,
  resolveRetrievalMode,
  type FusedChunk,
  type RankedChunk,
} from "../lib/hybridRetrieval.js"
import { rerankChunks } from "../lib/rerank.js"
import { recordRetrievalObservation, withHnswSearch } from "../lib/pgvectorHnsw.js"
import { currentRequestId } from "../lib/requestContext.js"
import { EmbeddingBudgetError } from "../lib/embeddingBudget.js"
import { EmbeddingDimensionError, EmbeddingPriceMissingError } from "../lib/embeddingPricing.js"
import { activeEmbeddingIdentity, embedTexts, toPgVectorLiteral } from "./embeddings.service.js"
import { getEntitlementForChatbot, type Entitlement } from "./billing.service.js"

function requireDbPool() {
  if (!pool) throw new AppError(503, "Database is not configured. Set DATABASE_URL and JWT_SECRET.")
  return pool
}

function requireUserId(accessToken: string): string {
  const userId = verifyAccessToken(accessToken)
  if (!userId) throw new AppError(401, "Please sign in again.")
  return userId
}

export interface ChatbotDocument {
  id: string
  fileName: string
  fileType: string
  fileSize: number
  status: "processing" | "ready" | "failed" | "paused_no_credits" | "rejected"
  errorMessage: string | null
  chunkCount: number
  pageCount: number | null
  scanStatus: DocumentScanStatus | null
  scanVendor: string | null
  scannedAt: string | null
  ingestStage: string | null
  ingestProgressPercent: number
  lastEmbeddedIndex: number
  extractionMethod: string | null
  createdAt: string
}

export type DocumentIngestStatus = {
  documentId: string
  status: ChatbotDocument["status"]
  stage: string
  progressPercent: number
  startedAt: string
  estimatedComplete: string | null
  error: string | null
}

const DOCUMENT_COLUMNS =
  "id, file_name, file_type, file_size, status, error_message, chunk_count, page_count, scan_status, scan_vendor, scanned_at, ingest_stage, ingest_progress_percent, last_embedded_index, extraction_method, created_at"

function mapDocumentRow(row: Record<string, unknown>): ChatbotDocument {
  return {
    id: row.id as string,
    fileName: row.file_name as string,
    fileType: row.file_type as string,
    fileSize: row.file_size as number,
    status: row.status as ChatbotDocument["status"],
    errorMessage: (row.error_message as string | null) ?? null,
    chunkCount: row.chunk_count as number,
    pageCount: row.page_count == null ? null : Number(row.page_count),
    scanStatus: (row.scan_status as DocumentScanStatus | null) ?? null,
    scanVendor: (row.scan_vendor as string | null) ?? null,
    scannedAt: row.scanned_at == null ? null : (row.scanned_at as Date).toISOString(),
    ingestStage: (row.ingest_stage as string | null) ?? null,
    ingestProgressPercent: Number(row.ingest_progress_percent ?? 0),
    lastEmbeddedIndex: Number(row.last_embedded_index ?? 0),
    extractionMethod: (row.extraction_method as string | null) ?? null,
    createdAt: (row.created_at as Date).toISOString(),
  }
}

const STAGE_PROGRESS: Record<string, number> = {
  queued: 5,
  scanning: 15,
  extracting: 30,
  chunking: 45,
  embedding: 65,
  storing: 90,
  ready: 100,
  paused_no_credits: 65,
  failed: 100,
  rejected: 100,
}

async function setIngestStage(documentId: string, stage: string, extra: Record<string, unknown> = {}): Promise<void> {
  const db = requireDbPool()
  const progress = STAGE_PROGRESS[stage] ?? 10
  await db.query(
    `update chatbot_documents
        set ingest_stage = $2,
            ingest_progress_percent = $3,
            updated_at = now()
      where id = $1`,
    [documentId, stage, extra.progressPercent ?? progress],
  )
}

async function writeIngestionLog(entry: {
  documentId: string
  chatbotId: string
  status: string
  extractionMethod?: string | null
  extractedChars?: number | null
  chunkCount?: number | null
  embeddingTokens?: number | null
  embeddingCostUsd?: number | null
  embeddingModel?: string | null
  scanDurationMs?: number | null
  extractionDurationMs?: number | null
  chunkingDurationMs?: number | null
  embeddingDurationMs?: number | null
  totalDurationMs?: number | null
  error?: string | null
}): Promise<void> {
  const db = requireDbPool()
  try {
    await db.query(
      `insert into document_ingestion_log (
         document_id, chatbot_id, status, extraction_method, extracted_chars, chunk_count,
         embedding_tokens, embedding_cost_usd, embedding_model, scan_duration_ms,
         extraction_duration_ms, chunking_duration_ms, embedding_duration_ms, total_duration_ms, error
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [
        entry.documentId,
        entry.chatbotId,
        entry.status,
        entry.extractionMethod ?? null,
        entry.extractedChars ?? null,
        entry.chunkCount ?? null,
        entry.embeddingTokens ?? null,
        entry.embeddingCostUsd ?? null,
        entry.embeddingModel ?? null,
        entry.scanDurationMs ?? null,
        entry.extractionDurationMs ?? null,
        entry.chunkingDurationMs ?? null,
        entry.embeddingDurationMs ?? null,
        entry.totalDurationMs ?? null,
        entry.error ?? null,
      ],
    )
  } catch (err) {
    log().warn(
      { err: err instanceof Error ? err.message : String(err), documentId: entry.documentId },
      "document_ingestion_log write failed",
    )
  }
}

async function requireDocumentIngestionPlan(chatbotId: string): Promise<Entitlement> {
  const entitlement = await getEntitlementForChatbot(chatbotId)
  console.log(`[documentIngestion] plan check: chatbotId=${chatbotId} plan=${entitlement.plan} documentIngestion.enabled=${entitlement.documentIngestion.enabled}`)
  if (!entitlement.documentIngestion.enabled) {
    throw new AppError(402, "Document uploads require the Crawl Plus plan or higher. Upgrade to upload documents.")
  }
  return entitlement
}

export interface DocumentIngestCapsSummary {
  enabled: boolean
  maxDocuments: number
  maxFileBytes: number
  maxChatbotBytes: number
  usedDocuments: number
  usedBytes: number
}

export interface DocumentListResult {
  documents: ChatbotDocument[]
  caps: DocumentIngestCapsSummary
}

export async function listDocuments(accessToken: string, chatbotId: string): Promise<DocumentListResult> {
  const db = requireDbPool()
  const actorUserId = requireUserId(accessToken)
  const { tenantUserId } = await resolveTenantContext(actorUserId, "viewer")
  const ownedId = await requireOwnedChatbotId(tenantUserId, chatbotId)
  console.log(`[documentIngestion] listDocuments: chatbotId=${ownedId}`)

  const entitlement = await getEntitlementForChatbot(ownedId)
  const { rows } = await db.query(
    `select ${DOCUMENT_COLUMNS} from chatbot_documents where chatbot_id = $1 order by created_at desc`,
    [ownedId],
  )
  console.log(`[documentIngestion] listDocuments: chatbotId=${ownedId} found ${rows.length} documents`)

  let caps: DocumentIngestCapsSummary
  if (!entitlement.documentIngestion.enabled) {
    caps = { enabled: false, maxDocuments: 0, maxFileBytes: 0, maxChatbotBytes: 0, usedDocuments: 0, usedBytes: 0 }
  } else {
    const resolved = await loadIngestCaps(ownedId, entitlement.documentIngestion)
    const notFailed = rows.filter((row) => row.status !== "failed")
    const usedBytes = notFailed.reduce((sum, row) => sum + Number(row.file_size ?? 0), 0)
    caps = {
      enabled: true,
      maxDocuments: resolved.maxDocuments,
      maxFileBytes: resolved.maxFileBytes,
      maxChatbotBytes: resolved.maxChatbotBytes,
      usedDocuments: notFailed.length,
      usedBytes,
    }
  }

  return { documents: rows.map(mapDocumentRow), caps }
}

export async function getDocumentStatus(
  accessToken: string,
  chatbotId: string,
  documentId: string,
): Promise<DocumentIngestStatus> {
  const db = requireDbPool()
  const actorUserId = requireUserId(accessToken)
  const { tenantUserId } = await resolveTenantContext(actorUserId, "viewer")
  const ownedId = await requireOwnedChatbotId(tenantUserId, chatbotId)
  const { rows } = await db.query(
    `select ${DOCUMENT_COLUMNS} from chatbot_documents where id = $1 and chatbot_id = $2`,
    [documentId, ownedId],
  )
  if (!rows[0]) throw new AppError(404, "Document not found.")
  const document = mapDocumentRow(rows[0])
  const stage = document.status === "ready" ? "ready" : document.ingestStage || "queued"
  const started = new Date(document.createdAt).getTime()
  const elapsed = Date.now() - started
  const estimated =
    document.status === "processing" && document.ingestProgressPercent > 5
      ? new Date(started + (elapsed / document.ingestProgressPercent) * 100).toISOString()
      : null
  return {
    documentId: document.id,
    status: document.status,
    stage,
    progressPercent: document.status === "ready" ? 100 : document.ingestProgressPercent,
    startedAt: document.createdAt,
    estimatedComplete: estimated,
    error: document.errorMessage,
  }
}

export async function resumePausedIngests(chatbotId: string): Promise<number> {
  const db = requireDbPool()
  const { rows } = await db.query<{ id: string }>(
    `select id from chatbot_documents
      where chatbot_id = $1 and status = 'paused_no_credits' and storage_key is not null`,
    [chatbotId],
  )
  for (const row of rows) {
    await db.query(
      `update chatbot_documents set status = 'processing', error_message = null, updated_at = now()
        where id = $1`,
      [row.id],
    )
    await enqueueDocumentIngestJob({ documentId: row.id, chatbotId })
  }
  return rows.length
}

// Exported so the upload middleware (uploadDocument.ts) can resolve the
// same plan-aware caps before multer runs, without duplicating this query.
export async function loadIngestCaps(chatbotId: string, documentIngestion: DocumentIngestionConfig): Promise<IngestCaps> {
  const db = requireDbPool()
  const { rows } = await db.query<{
    max_documents: number | null
    max_bytes: string | number | null
    max_chunks: number | null
  }>(
    `select max_documents, max_bytes, max_chunks from chatbots where id = $1`,
    [chatbotId],
  )
  const row = rows[0]
  return resolveIngestCapsForPlan(
    {
      maxDocuments: documentIngestion.maxDocuments,
      maxFileSizeBytes: documentIngestion.maxFileSizeBytes,
      maxChatbotBytes: documentIngestion.maxChatbotBytes,
    },
    {
      maxDocuments: row?.max_documents ?? null,
      maxBytes: row?.max_bytes == null ? null : Number(row.max_bytes),
      maxChunks: row?.max_chunks ?? null,
    },
  )
}

function shouldProcessInline(fileSize: number): boolean {
  return !env.documentIngestAsync && fileSize <= env.documentIngestSyncMaxBytes
}

function estimatePageCount(text: string): number {
  return Math.max(1, (text.match(/\f/g) || []).length + 1)
}

export async function processPersistedDocument(documentId: string, expectedChatbotId?: string): Promise<ChatbotDocument> {
  const db = requireDbPool()
  const { rows } = await db.query(
    `select id, chatbot_id, file_name, file_type, file_size, status, storage_key, error_message, chunk_count, page_count,
            scan_status, scan_vendor, scanned_at, last_embedded_index, created_at
     from chatbot_documents where id = $1`,
    [documentId],
  )
  const row = rows[0]
  if (!row) throw new AppError(404, "Document not found.")
  if (expectedChatbotId && row.chatbot_id !== expectedChatbotId) {
    throw new AppError(404, "Document not found.")
  }
  if (row.status === "ready") return mapDocumentRow(row)
  if (row.scan_status === "denied") {
    return mapDocumentRow(row)
  }
  if (!row.storage_key) throw new AppError(409, "This document has no stored bytes to process.")

  const ownedId = row.chatbot_id as string
  const entitlementForCaps = await getEntitlementForChatbot(ownedId)
  const caps = await loadIngestCaps(ownedId, entitlementForCaps.documentIngestion)
  const buffer = await getDocumentObject(row.storage_key as string)
  const pipelineStarted = Date.now()
  let scanDurationMs = 0
  let extractionDurationMs = 0
  let chunkingDurationMs = 0
  let embeddingDurationMs = 0
  let extractionMethod: string | null = null
  let extractedChars = 0

  try {
    await setIngestStage(documentId, "scanning")
    const scanStarted = Date.now()
    const scan = await scanDocumentBytes(buffer)
    scanDurationMs = Date.now() - scanStarted
    await db.query(
      `update chatbot_documents
       set scan_status = $1, scan_vendor = $2, scanned_at = now(), updated_at = now()
       where id = $3`,
      [scan.status, scan.vendor, documentId],
    )
    if (scan.status === "denied") {
      console.error(`[documentIngestion] processPersistedDocument: MALWARE DENIED documentId=${documentId}`)
      await incrementIngestMetric("ingest.scan_denied", { documentId, chatbotId: ownedId, vendor: scan.vendor })
      await db.query(
        `update chatbot_documents
         set status = 'failed', error_message = $1, storage_key = null, updated_at = now()
         where id = $2 and status = 'processing'`,
        [MALWARE_DENIED_MESSAGE, documentId],
      )
      await deleteDocumentObject(row.storage_key as string)
      const { rows: deniedRows } = await db.query(
        `select ${DOCUMENT_COLUMNS} from chatbot_documents where id = $1`,
        [documentId],
      )
      return mapDocumentRow(deniedRows[0])
    }
    if (scan.status === "error") {
      throw new MalwareScanUnavailableError(scan.message)
    }

    const type = detectDocumentType(row.file_name as string)
    await setIngestStage(documentId, "extracting")
    const extractStarted = Date.now()
    const extracted = await extractTextWithMethod(buffer, type)
    extractionDurationMs = Date.now() - extractStarted
    const text = extracted.text
    extractionMethod = extracted.method
    extractedChars = text.length
    await db.query(`update chatbot_documents set extraction_method = $1 where id = $2`, [extractionMethod, documentId])
    const { rows: chunkSizeRows } = await db.query<{ chunk_target_chars: number }>(
      "select chunk_target_chars from chatbots where id = $1",
      [ownedId],
    )
    await setIngestStage(documentId, "chunking")
    const chunkStarted = Date.now()
    const chunks = semanticChunk(text, { targetChunkSize: chunkSizeRows[0]?.chunk_target_chars || 1200 })
    chunkingDurationMs = Date.now() - chunkStarted
    console.log(`[documentIngestion] processPersistedDocument: documentId=${documentId} extracted ${text.length} chars into ${chunks.length} chunks (semantic, v2)`)

    if (chunks.length === 0) {
      throw new AppError(422, "No usable text content found in this file.")
    }

    await enforceIngestCap(() => assertDocumentChunks(chunks.length, caps))

    const { rows: chunkUsage } = await db.query<{ chunks: string }>(
      `select coalesce(sum(chunk_count), 0)::text as chunks
       from chatbot_documents where chatbot_id = $1 and id <> $2`,
      [ownedId, documentId],
    )
    await enforceIngestCap(() => assertChatbotChunks(Number(chunkUsage[0].chunks), chunks.length, caps))

    const quality = await verifyExtractedText(text, row.file_name as string, type)
    if (!quality.ok) {
      throw new AppError(422, quality.reason)
    }

    await setIngestStage(documentId, "embedding")
    const embedStarted = Date.now()
    const resumeFrom = Number(row.last_embedded_index ?? 0)
    const identity = activeEmbeddingIdentity()
    if (resumeFrom === 0) {
      await db.query("delete from chatbot_document_chunks where document_id = $1 and chatbot_id = $2", [
        documentId,
        ownedId,
      ])
    }
    const batchSize = env.documentIngestEmbeddingBatchSize
    try {
      for (let startIndex = resumeFrom; startIndex < chunks.length; startIndex += batchSize) {
        const batch = chunks.slice(startIndex, startIndex + batchSize)
        const batchVectors = await embedTexts(batch.map(embeddingTextFor), {
          chatbotId: ownedId,
          purpose: "document_ingest",
        })
        for (let j = 0; j < batch.length; j += 1) {
          const chunk = batch[j]
          const vector = batchVectors[j]
          await db.query(
            `insert into chatbot_document_chunks
               (document_id, chatbot_id, content, embedding, content_tsv, source_type, embedding_model, embedding_dim,
                heading, section, document_type, token_estimate, chunking_version)
             values ($1, $2, $3, $4, to_tsvector($5::regconfig, $3), 'document', $6, $7, $8, $9, $10, $11, 2)`,
            [
              documentId,
              ownedId,
              chunk.text,
              vector ? toPgVectorLiteral(vector) : null,
              env.retrievalTsConfig,
              vector ? identity.model : null,
              vector ? identity.dim : null,
              chunk.heading,
              chunk.section,
              chunk.documentType,
              chunk.tokenEstimate,
            ],
          )
        }
        await db.query(`update chatbot_documents set last_embedded_index = $1, updated_at = now() where id = $2`, [
          startIndex + batch.length,
          documentId,
        ])
      }
    } catch (err) {
      if (err instanceof EmbeddingBudgetError) {
        await db.query(
          `update chatbot_documents
              set status = 'paused_no_credits',
                  ingest_stage = 'paused_no_credits',
                  error_message = $1,
                  updated_at = now()
            where id = $2`,
          ["Embedding paused — top up AI credits to resume.", documentId],
        )
        await writeIngestionLog({
          documentId,
          chatbotId: ownedId,
          status: "paused_no_credits",
          extractionMethod,
          extractedChars,
          chunkCount: chunks.length,
          scanDurationMs,
          extractionDurationMs,
          chunkingDurationMs,
          embeddingDurationMs: Date.now() - embedStarted,
          totalDurationMs: Date.now() - pipelineStarted,
          error: err.message,
        })
        const { rows: pausedRows } = await db.query(`select ${DOCUMENT_COLUMNS} from chatbot_documents where id = $1`, [
          documentId,
        ])
        return mapDocumentRow(pausedRows[0])
      }
      throw err
    }
    embeddingDurationMs = Date.now() - embedStarted
    console.log(`[documentIngestion] processPersistedDocument: documentId=${documentId} embedded chunks model=${identity.model} dim=${identity.dim}`)

    await setIngestStage(documentId, "storing")
    const writeClient = await db.connect()
    try {
      await writeClient.query("begin")
      await writeClient.query("select id from chatbots where id = $1 for update", [ownedId])
      const { rows: lockedChunkUsage } = await writeClient.query<{ chunks: string }>(
        `select coalesce(sum(chunk_count), 0)::text as chunks
         from chatbot_documents where chatbot_id = $1 and id <> $2`,
        [ownedId, documentId],
      )
      await enforceIngestCap(() => assertChatbotChunks(Number(lockedChunkUsage[0].chunks), chunks.length, caps))

      const { rows: readyRows } = await writeClient.query(
        `update chatbot_documents
         set status = 'ready', error_message = null, chunk_count = $1, page_count = $2,
             ingest_stage = 'ready', ingest_progress_percent = 100, updated_at = now()
         where id = $3
         returning ${DOCUMENT_COLUMNS}`,
        [chunks.length, estimatePageCount(text), documentId],
      )
      await writeClient.query("commit")
      await bumpChatbotCacheVersion(ownedId)
      await writeIngestionLog({
        documentId,
        chatbotId: ownedId,
        status: "ready",
        extractionMethod,
        extractedChars,
        chunkCount: chunks.length,
        embeddingModel: identity.model,
        scanDurationMs,
        extractionDurationMs,
        chunkingDurationMs,
        embeddingDurationMs,
        totalDurationMs: Date.now() - pipelineStarted,
      })
      console.log(`[documentIngestion] processPersistedDocument: DONE documentId=${documentId} status=ready chunkCount=${chunks.length}`)
      void afterIngestReady(ownedId, documentId)
      return mapDocumentRow(readyRows[0])
    } catch (err) {
      await writeClient.query("rollback").catch(() => undefined)
      throw err
    } finally {
      writeClient.release()
    }
  } catch (err) {
    if (err instanceof AppError && err.cap) {
      console.error(`[documentIngestion] processPersistedDocument: REJECTED (cap=${err.cap}) documentId=${documentId}`)
      await db.query("delete from chatbot_documents where id = $1 and chatbot_id = $2", [documentId, ownedId])
      await deleteDocumentObject(row.storage_key as string)
      throw err
    }
    if (err instanceof MalwareScanUnavailableError) {
      await incrementIngestMetric("ingest.scan_error", { documentId, chatbotId: ownedId })
      await db.query(
        `update chatbot_documents
         set scan_status = 'error', scanned_at = now(), updated_at = now()
         where id = $1 and status = 'processing'`,
        [documentId],
      )
      throw err
    }
    const message = err instanceof AppError ? err.message : "Failed to process this file."
    console.error(`[documentIngestion] processPersistedDocument: FAILED documentId=${documentId}`, err)
    await incrementIngestMetric("ingest.failed", { documentId, chatbotId: ownedId })
    const { rows: failedRows } = await db.query(
      `update chatbot_documents
       set status = 'failed', error_message = $1, updated_at = now()
       where id = $2 and status = 'processing'
       returning ${DOCUMENT_COLUMNS}`,
      [message, documentId],
    )
    if (failedRows[0]) return mapDocumentRow(failedRows[0])
    const { rows: current } = await db.query(
      `select ${DOCUMENT_COLUMNS} from chatbot_documents where id = $1`,
      [documentId],
    )
    if (!current[0]) throw new AppError(404, "Document not found.")
    return mapDocumentRow(current[0])
  }
}

// WP-3.3 background re-chunking migration. Finds ONE document at a time
// still on chunking_version 1 (the old chunkText.ts output) and re-chunks
// it with semanticChunk — one document per call keeps this rate-limited and
// tenant-isolated (a worker tick processes at most one document, so no
// single chatbot's backlog can starve every other tenant's turn). Malware
// scanning is skipped: the bytes haven't changed since they already passed
// scan during the original upload.
export async function findNextLegacyChunkDocumentId(): Promise<string | null> {
  const db = requireDbPool()
  const { rows } = await db.query<{ document_id: string }>(
    `select d.id as document_id
       from chatbot_documents d
      where d.status = 'ready'
        and d.storage_key is not null
        and exists (
          select 1 from chatbot_document_chunks c
          where c.document_id = d.id and c.chunking_version = 1
        )
        and not exists (
          select 1 from chatbot_document_chunks c2
          where c2.document_id = d.id and c2.chunking_version = 2
        )
      order by d.created_at asc
      limit 1`,
  )
  return rows[0]?.document_id ?? null
}

export async function rechunkLegacyDocument(documentId: string): Promise<{ chatbotId: string; oldChunks: number; newChunks: number }> {
  const db = requireDbPool()
  const { rows } = await db.query<{
    chatbot_id: string
    file_name: string
    storage_key: string | null
  }>(
    `select chatbot_id, file_name, storage_key from chatbot_documents where id = $1 and status = 'ready'`,
    [documentId],
  )
  const row = rows[0]
  if (!row?.storage_key) {
    throw new AppError(404, "Document not found or has no stored bytes to re-chunk.")
  }
  const ownedId = row.chatbot_id

  const buffer = await getDocumentObject(row.storage_key)
  const type = detectDocumentType(row.file_name)
  const text = await extractText(buffer, type)

  const { rows: chunkSizeRows } = await db.query<{ chunk_target_chars: number }>(
    "select chunk_target_chars from chatbots where id = $1",
    [ownedId],
  )
  const chunks = semanticChunk(text, { targetChunkSize: chunkSizeRows[0]?.chunk_target_chars || 1200 })
  if (chunks.length === 0) {
    throw new AppError(422, "Re-chunking produced no usable content — leaving the existing (version 1) chunks in place.")
  }

  const embeddings = await embedTexts(chunks.map(embeddingTextFor), { chatbotId: ownedId, purpose: "document_ingest" })
  const identity = activeEmbeddingIdentity()

  const writeClient = await db.connect()
  try {
    await writeClient.query("begin")

    // Insert the new (version 2) chunks FIRST, before removing the old
    // ones — under READ COMMITTED, no other session can observe a partial
    // state either way, but ordering it this way means that even within
    // this same transaction, a document is never represented by zero
    // chunks at any statement boundary.
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]
      await writeClient.query(
        `insert into chatbot_document_chunks
           (document_id, chatbot_id, content, embedding, content_tsv, source_type, embedding_model, embedding_dim,
            heading, section, document_type, token_estimate, chunking_version)
         values ($1, $2, $3, $4, to_tsvector($5::regconfig, $3), 'document', $6, $7, $8, $9, $10, $11, 2)`,
        [
          documentId,
          ownedId,
          chunk.text,
          embeddings[i] ? toPgVectorLiteral(embeddings[i] as number[]) : null,
          env.retrievalTsConfig,
          embeddings[i] ? identity.model : null,
          embeddings[i] ? identity.dim : null,
          chunk.heading,
          chunk.section,
          chunk.documentType,
          chunk.tokenEstimate,
        ],
      )
    }

    const { rowCount: oldChunkCount } = await writeClient.query(
      "delete from chatbot_document_chunks where document_id = $1 and chatbot_id = $2 and chunking_version = 1",
      [documentId, ownedId],
    )

    await writeClient.query(
      "update chatbot_documents set chunk_count = $1, updated_at = now() where id = $2",
      [chunks.length, documentId],
    )

    await writeClient.query("commit")
    await bumpChatbotCacheVersion(ownedId)
    log().info(
      { documentId, chatbotId: ownedId, oldChunks: oldChunkCount ?? 0, newChunks: chunks.length },
      "re-chunked document to semantic chunking (v2)",
    )
    return { chatbotId: ownedId, oldChunks: oldChunkCount ?? 0, newChunks: chunks.length }
  } catch (err) {
    await writeClient.query("rollback").catch(() => undefined)
    throw err
  } finally {
    writeClient.release()
  }
}

function duplicateFileError(): AppError {
  return new AppError(409, "This file has already been uploaded to this chatbot.", {
    code: "DUPLICATE_FILE",
  })
}

// Postgres unique_violation. Used as defense-in-depth against the dedup
// partial index (idx_chatbot_documents_dedup) when two uploads of the same
// file race past the pre-check below at the same time.
function isUniqueViolation(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && (err as { code?: string }).code === "23505")
}

export async function uploadDocument(
  accessToken: string,
  chatbotId: string,
  file: { originalname: string; mimetype: string; size: number; buffer: Buffer },
): Promise<{ document: ChatbotDocument; accepted: boolean }> {
  const db = requireDbPool()
  const actorUserId = requireUserId(accessToken)
  const { tenantUserId } = await resolveTenantContext(actorUserId, "admin")
  const ownedId = await requireOwnedChatbotId(tenantUserId, chatbotId)
  console.log(`[documentIngestion] uploadDocument: START chatbotId=${ownedId} fileName="${file.originalname}" size=${file.size} bytes`)

  const entitlement = await requireDocumentIngestionPlan(ownedId)
  if (env.documentScanPauseUploads) {
    throw new AppError(503, "Document uploads are paused while malware scanning is unavailable.")
  }

  const caps = await loadIngestCaps(ownedId, entitlement.documentIngestion)
  await enforceIngestCap(() => assertFileBytes(file.size, caps))

  // Dedup runs before the quota check — an exact duplicate never spends a
  // slot. file_hash + idx_chatbot_documents_dedup (chatbot_id, file_hash)
  // where status <> 'failed' backs this at the DB level too.
  const fileHash = createHash("sha256").update(file.buffer).digest("hex")
  const { rows: dupRows } = await db.query(
    `select id from chatbot_documents where chatbot_id = $1 and file_hash = $2 and status <> 'failed'`,
    [ownedId, fileHash],
  )
  if (dupRows[0]) throw duplicateFileError()

  const type = detectDocumentType(file.originalname)
  const documentId = randomUUID()
  const storageKey = documentStorageKey(ownedId, documentId, file.originalname)
  const client = await db.connect()
  let document: ChatbotDocument
  try {
    await client.query("begin")
    await client.query("select id from chatbots where id = $1 for update", [ownedId])
    const { rows: usageRows } = await client.query<{ documents: string; bytes: string }>(
      `select count(*)::text as documents, coalesce(sum(file_size), 0)::text as bytes
       from chatbot_documents where chatbot_id = $1 and status <> 'failed'`,
      [ownedId],
    )
    await enforceIngestCap(() => assertDocumentCount(Number(usageRows[0].documents), caps))
    await enforceIngestCap(() => assertChatbotBytes(Number(usageRows[0].bytes), file.size, caps))

    await putDocumentObject(storageKey, file.buffer)

    const { rows: docRows } = await client.query(
      `insert into chatbot_documents
         (id, chatbot_id, file_name, file_type, file_size, bytes, storage_key, status, scan_status, file_hash)
       values ($1, $2, $3, $4, $5, $6, $7, 'processing', 'pending', $8)
       returning ${DOCUMENT_COLUMNS}`,
      [documentId, ownedId, file.originalname, type, file.size, file.size, storageKey, fileHash],
    )
    document = mapDocumentRow(docRows[0])
    await client.query("commit")
  } catch (err) {
    await client.query("rollback").catch(() => undefined)
    await deleteDocumentObject(storageKey)
    if (isUniqueViolation(err)) throw duplicateFileError()
    throw err
  } finally {
    client.release()
  }
  console.log(`[documentIngestion] uploadDocument: persisted document row id=${document.id} storageKey=${storageKey}`)

  if (shouldProcessInline(file.size)) {
    const processed = await processPersistedDocument(document.id, ownedId)
    return { document: processed, accepted: false }
  }

  try {
    await enqueueDocumentIngestJob({
      documentId: document.id,
      chatbotId: ownedId,
      requestId: currentRequestId(),
    })
  } catch (err) {
    console.error(`[documentIngestion] uploadDocument: enqueue failed documentId=${document.id}`, err)
  }
  await observeIngestProcessingAge()
  return { document, accepted: true }
}

export async function retryDocument(accessToken: string, chatbotId: string, documentId: string): Promise<ChatbotDocument> {
  const db = requireDbPool()
  const actorUserId = requireUserId(accessToken)
  const { tenantUserId } = await resolveTenantContext(actorUserId, "admin")
  const ownedId = await requireOwnedChatbotId(tenantUserId, chatbotId)
  const { rows } = await db.query(
    `select id, status, storage_key, scan_status from chatbot_documents where id = $1 and chatbot_id = $2`,
    [documentId, ownedId],
  )
  if (!rows[0]) throw new AppError(404, "Document not found.")
  if (rows[0].scan_status === "denied") {
    throw new AppError(409, "This file was rejected by the malware scan and cannot be reprocessed.")
  }
  if (!rows[0].storage_key) throw new AppError(409, "This document has no stored bytes to reprocess.")

  const { rows: reset } = await db.query(
    `update chatbot_documents
     set status = 'processing', error_message = null, updated_at = now()
     where id = $1 and chatbot_id = $2
     returning ${DOCUMENT_COLUMNS}`,
    [documentId, ownedId],
  )
  const document = mapDocumentRow(reset[0])
  if (shouldProcessInline(document.fileSize)) {
    return processPersistedDocument(document.id, ownedId)
  }
  await enqueueDocumentIngestJob({ documentId: document.id, chatbotId: ownedId, requestId: currentRequestId() })
  return document
}

export async function requeueStaleProcessingDocuments(): Promise<number> {
  const db = requireDbPool()
  const { rows } = await db.query<{ id: string; chatbot_id: string }>(
    `select id, chatbot_id from chatbot_documents
     where status = 'processing' and storage_key is not null
       and coalesce(updated_at, created_at) < now() - ($1::text || ' milliseconds')::interval`,
    [String(env.documentIngestStaleProcessingMs)],
  )
  for (const row of rows) {
    await enqueueDocumentIngestJob({ documentId: row.id, chatbotId: row.chatbot_id })
  }
  await observeIngestProcessingAge()
  return rows.length
}

export async function deleteDocument(accessToken: string, chatbotId: string, documentId: string): Promise<void> {
  const db = requireDbPool()
  const actorUserId = requireUserId(accessToken)
  const { tenantUserId } = await resolveTenantContext(actorUserId, "admin")
  const ownedId = await requireOwnedChatbotId(tenantUserId, chatbotId)
  console.log(`[documentIngestion] deleteDocument: chatbotId=${ownedId} documentId=${documentId}`)

  const { rows } = await db.query<{ storage_key: string | null }>(
    "select storage_key from chatbot_documents where id = $1 and chatbot_id = $2",
    [documentId, ownedId],
  )
  if (!rows[0]) {
    console.error(`[documentIngestion] deleteDocument: NOT FOUND chatbotId=${ownedId} documentId=${documentId}`)
    throw new AppError(404, "Document not found.")
  }
  await db.query("delete from chatbot_documents where id = $1 and chatbot_id = $2", [documentId, ownedId])
  if (rows[0].storage_key) await deleteDocumentObject(rows[0].storage_key)
  await bumpChatbotCacheVersion(ownedId)
  console.log(`[documentIngestion] deleteDocument: DELETED documentId=${documentId}`)
}

// Called from the answering pipeline (answerChatbotQuestion.ts), not the
// dashboard — returns the top-K chunks relevant to this question as
// CrawledPage-shaped entries so they merge into the same context/grounding
// pipeline as crawled site pages and live data. Silently returns [] for a
// chatbot with no documents or no embedding provider configured — the
// feature just doesn't add anything in that case, not an error.
type RetrievedChunkRow = { id: string; content: string; file_name: string; distance?: string }

function toRankedChunks(rows: RetrievedChunkRow[], source: RankedChunk["source"]): RankedChunk[] {
  return rows.map((row, index) => ({
    id: row.id,
    content: row.content,
    fileName: row.file_name,
    source,
    rank: index + 1,
  }))
}

async function lookupLexicalChunks(chatbotId: string, question: string, limit: number): Promise<RankedChunk[]> {
  if (!pool) return []
  const { rows } = await pool.query<RetrievedChunkRow>(
    `select c.id, c.content, d.file_name
     from chatbot_document_chunks c
     join chatbot_documents d on d.id = c.document_id
     where c.chatbot_id = $1
       and d.status = 'ready'
       and c.content_tsv is not null
       and c.content_tsv @@ plainto_tsquery($2::regconfig, $3)
     order by ts_rank_cd(c.content_tsv, plainto_tsquery($2::regconfig, $3)) desc, c.id
     limit $4`,
    [chatbotId, env.retrievalTsConfig, question, limit],
  )
  return toRankedChunks(rows, "lexical")
}

async function lookupVectorChunks(chatbotId: string, question: string, limit: number): Promise<RankedChunk[]> {
  if (!pool) return []
  let identity
  let embedding: number[] | null
  try {
    identity = activeEmbeddingIdentity()
    const embeddings = await embedTexts([question], { chatbotId, purpose: "document_query" })
    embedding = embeddings[0] ?? null
  } catch (err) {
    if (
      err instanceof EmbeddingBudgetError ||
      err instanceof EmbeddingPriceMissingError ||
      err instanceof EmbeddingDimensionError
    ) {
      log().warn(
        { chatbotId, err: err.message },
        "document vector lookup skipped because embedding is unavailable or over budget",
      )
      return []
    }
    throw err
  }
  if (!embedding) return []

  const { rows } = await withHnswSearch(pool, (client) =>
    client.query<RetrievedChunkRow>(
      `select c.id, c.content, d.file_name, c.embedding <=> $2 as distance
       from chatbot_document_chunks c
       join chatbot_documents d on d.id = c.document_id
       where c.chatbot_id = $1 and c.embedding is not null and d.status = 'ready'
         and c.embedding_model = $5 and c.embedding_dim = $6
         and (c.embedding <=> $2) <= $3
       order by distance
       limit $4`,
      [chatbotId, toPgVectorLiteral(embedding), env.documentRetrievalMaxDistance, limit, identity.model, identity.dim],
    ),
  )
  return toRankedChunks(rows, "vector")
}

export async function lookupRelevantDocumentChunks(
  chatbotId: string,
  question: string,
  limit = env.documentRetrievalLimit,
): Promise<CrawledPage[]> {
  if (!pool) return []
  setTenantContext({ chatbotId })

  const startedAt = Date.now()
  const mode = resolveRetrievalMode()
  const vectorLimit = mode === "hybrid" ? env.retrievalVectorCandidates : limit
  const [lexical, vector] = await Promise.all([
    mode === "hybrid" ? lookupLexicalChunks(chatbotId, question, env.retrievalLexicalCandidates) : Promise.resolve([]),
    lookupVectorChunks(chatbotId, question, vectorLimit),
  ])

  // Keep a wider candidate pool alive through fusion when rerank is on, so
  // there's something for the reranker to actually reorder — truncating to
  // `limit` before reranking would defeat the point of it.
  const poolSize = env.retrievalRerankEnabled ? Math.max(limit, env.retrievalRerankCandidatePool) : limit
  const fusedPool: FusedChunk[] =
    mode === "hybrid"
      ? fuseLexicalAndVector(lexical, vector, env.retrievalRrfK).slice(0, poolSize)
      : vector.slice(0, poolSize).map((chunk) => ({
          id: chunk.id,
          content: chunk.content,
          fileName: chunk.fileName,
          score: 1 / chunk.rank,
          lexicalRank: null,
          vectorRank: chunk.rank,
        }))

  if (lexical.length > 0) await incrementRetrievalMetric("retrieval.lexical_hits", { chatbotId, hits: lexical.length })
  if (vector.length > 0) await incrementRetrievalMetric("retrieval.vector_hits", { chatbotId, hits: vector.length })
  if (fusedPool.length === 0) await incrementRetrievalMetric("retrieval.empty", { chatbotId, mode })

  if (env.retrievalShadowCompare && mode === "hybrid") {
    const vectorOnlyIds = new Set(vector.slice(0, limit).map((chunk) => chunk.id))
    const fusedIds = fusedPool.slice(0, limit).map((chunk) => chunk.id)
    log().info(
      {
        chatbotId,
        overlap: fusedIds.filter((id) => vectorOnlyIds.has(id)).length,
        fused: fusedIds.length,
        vectorOnly: vectorOnlyIds.size,
      },
      "retrieval.shadow_compare",
    )
  }

  const fused = fusedPool.length > 0 ? await rerankChunks(chatbotId, question, fusedPool, limit) : fusedPool

  await recordRetrievalObservation("document", {
    elapsedMs: Date.now() - startedAt,
    returned: fused.length,
    limit,
  })
  console.log(
    `[documentIngestion] lookupRelevantDocumentChunks: chatbotId=${chatbotId} mode=${mode} lexical=${lexical.length} vector=${vector.length} pool=${fusedPool.length} fused=${fused.length} question="${question.slice(0, 60)}"`,
  )

  return fused.map((row) => ({
    path: `document:${row.fileName}#${row.id}`,
    title: row.fileName,
    text: row.content,
    kind: "document" as const,
  }))
}

export async function backfillDocumentChunkTsvectors(batchSize = 500): Promise<number> {
  const db = requireDbPool()
  const { rowCount } = await db.query(
    `update chatbot_document_chunks as target
     set content_tsv = to_tsvector($1::regconfig, target.content)
     from (
       select id from chatbot_document_chunks
       where content_tsv is null
       order by created_at
       limit $2
     ) as batch
     where target.id = batch.id`,
    [env.retrievalTsConfig, batchSize],
  )
  return rowCount ?? 0
}

/** Gradual cutover: rewrite a batch of chunks whose model/dim is not the active identity. */
export async function reembedMismatchedDocumentChunks(batchSize = 25): Promise<number> {
  const db = requireDbPool()
  const identity = activeEmbeddingIdentity()
  const { rows } = await db.query<{ id: string; chatbot_id: string; content: string }>(
    `select id, chatbot_id, content
     from chatbot_document_chunks
     where embedding is not null
       and (embedding_model is distinct from $1 or embedding_dim is distinct from $2)
     order by created_at
     limit $3`,
    [identity.model, identity.dim, batchSize],
  )
  if (rows.length === 0) return 0

  const byChatbot = new Map<string, typeof rows>()
  for (const row of rows) {
    const list = byChatbot.get(row.chatbot_id) ?? []
    list.push(row)
    byChatbot.set(row.chatbot_id, list)
  }

  let updated = 0
  for (const [chatbotId, batch] of byChatbot) {
    const embeddings = await embedTexts(
      batch.map((row) => row.content),
      { chatbotId, purpose: "document_ingest" },
    )
    for (let i = 0; i < batch.length; i++) {
      const embedding = embeddings[i]
      if (!embedding) continue
      const result = await db.query(
        `update chatbot_document_chunks
         set embedding = $2, embedding_model = $3, embedding_dim = $4
         where id = $1 and chatbot_id = $5`,
        [batch[i].id, toPgVectorLiteral(embedding), identity.model, identity.dim, chatbotId],
      )
      updated += result.rowCount ?? 0
    }
  }
  return updated
}

async function afterIngestReady(chatbotId: string, documentId: string): Promise<void> {
  log().info({ event: "ingest.pipeline_complete", chatbotId, documentId }, "document ingest ready")
  try {
    const leaked = await runWithTenantContext({ scope: "worker", chatbotId }, async () => {
      const { rows } = await requireDbPool().query<{ n: string }>(
        `select count(*)::text as n from chatbot_document_chunks where chatbot_id <> $1`,
        [chatbotId],
      )
      return Number(rows[0]?.n ?? 0)
    })
    if (leaked > 0) {
      const { recordSecurityEvent } = await import("./securityAudit.service.js")
      await recordSecurityEvent({
        eventType: "rls_violation",
        chatbotId,
        details: { leaked, documentId, event: "ingest_isolation_probe" },
      })
    }
  } catch (err) {
    log().warn(
      {
        event: "ingest.isolation_probe_failed",
        chatbotId,
        err: err instanceof Error ? err.message : String(err),
      },
      "ingest isolation probe failed",
    )
  }
  try {
    const { suggestOKFConcepts } = await import("./okfSuggestion.service.js")
    await suggestOKFConcepts(documentId, chatbotId)
  } catch (err) {
    log().warn(
      {
        event: "okf.suggest_failed",
        chatbotId,
        documentId,
        err: err instanceof Error ? err.message : String(err),
      },
      "okf suggestion stage failed open",
    )
  }
}
