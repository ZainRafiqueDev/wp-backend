import { env } from "../env.js"
import { AppError } from "./errors.js"
import { log } from "./logger.js"
import { cacheRedis } from "./redis.js"

export type IngestCapReason = "documents" | "bytes" | "chunks"

export interface IngestCaps {
  maxDocuments: number
  maxFileBytes: number
  maxChatbotBytes: number
  maxChunksPerDocument: number
  maxChunksPerChatbot: number
}

export interface ChatbotIngestOverrides {
  maxDocuments: number | null
  maxBytes: number | null
  maxChunks: number | null
}

// Legacy/global-default shape — kept exactly as-is (zero-arg call still
// returns the Full Custom-equivalent env defaults) so nothing that already
// called this with just overrides (or no args) changes behavior. Plan-aware
// callers use resolveIngestCapsForPlan below instead.
export function resolveIngestCaps(overrides: ChatbotIngestOverrides = {
  maxDocuments: null,
  maxBytes: null,
  maxChunks: null,
}): IngestCaps {
  return {
    maxDocuments: positiveInt(overrides.maxDocuments, env.documentMaxPerChatbot),
    maxFileBytes: env.documentMaxFileBytes,
    maxChatbotBytes: positiveInt(overrides.maxBytes, env.documentMaxChatbotBytes),
    maxChunksPerDocument: env.documentMaxChunksPerDocument,
    maxChunksPerChatbot: positiveInt(overrides.maxChunks, env.documentMaxChunksPerChatbot),
  }
}

export interface PlanIngestCaps {
  maxDocuments: number
  maxFileSizeBytes: number
  maxChatbotBytes: number
}

// 2026-10-26: Crawl Plus and Full Custom now have different document caps
// (plans.ts's DocumentIngestionConfig), so the plan's own numbers are the
// base instead of a single global env default. Per-chatbot override columns
// still win over the plan default when set, same as before. maxFileBytes is
// never overridden per-chatbot — only documents / total bytes / chunks are.
export function resolveIngestCapsForPlan(
  planCaps: PlanIngestCaps,
  overrides: ChatbotIngestOverrides = { maxDocuments: null, maxBytes: null, maxChunks: null },
): IngestCaps {
  return {
    maxDocuments: positiveInt(overrides.maxDocuments, planCaps.maxDocuments),
    maxFileBytes: planCaps.maxFileSizeBytes,
    maxChatbotBytes: positiveInt(overrides.maxBytes, planCaps.maxChatbotBytes),
    maxChunksPerDocument: env.documentMaxChunksPerDocument,
    maxChunksPerChatbot: positiveInt(overrides.maxChunks, env.documentMaxChunksPerChatbot),
  }
}

function positiveInt(override: number | null | undefined, fallback: number): number {
  if (typeof override === "number" && Number.isFinite(override) && override > 0) return Math.floor(override)
  return fallback
}

export function ingestCapError(
  status: number,
  reason: IngestCapReason,
  message: string,
  extras?: { code?: string; data?: Record<string, unknown> },
): AppError {
  return new AppError(status, message, { cap: reason, code: extras?.code, data: extras?.data })
}

export function assertDocumentCount(currentDocuments: number, caps: IngestCaps): void {
  if (currentDocuments >= caps.maxDocuments) {
    throw ingestCapError(
      409,
      "documents",
      `You've reached the ${caps.maxDocuments}-document limit for this chatbot. Delete an existing document first.`,
      { code: "DOC_LIMIT_REACHED", data: { used: currentDocuments, limit: caps.maxDocuments } },
    )
  }
}

// 413, not 409 — a single file over the plan's per-file size cap, checked
// pre-buffer by the upload middleware and again here as the ground truth.
export function assertFileBytes(fileBytes: number, caps: IngestCaps): void {
  if (fileBytes > caps.maxFileBytes) {
    throw ingestCapError(
      413,
      "bytes",
      `File is too large — max ${Math.floor(caps.maxFileBytes / (1024 * 1024))}MB.`,
      { code: "FILE_TOO_LARGE", data: { limit: caps.maxFileBytes } },
    )
  }
}

export function assertChatbotBytes(currentBytes: number, incomingBytes: number, caps: IngestCaps): void {
  if (currentBytes + incomingBytes > caps.maxChatbotBytes) {
    throw ingestCapError(
      409,
      "bytes",
      `This upload would exceed the ${Math.floor(caps.maxChatbotBytes / (1024 * 1024))}MB storage limit for this chatbot.`,
      { code: "DOC_LIMIT_REACHED", data: { used: currentBytes, limit: caps.maxChatbotBytes } },
    )
  }
}

export function assertDocumentChunks(chunkCount: number, caps: IngestCaps): void {
  if (chunkCount > caps.maxChunksPerDocument) {
    throw ingestCapError(
      409,
      "chunks",
      `This file produced ${chunkCount} chunks, above the ${caps.maxChunksPerDocument}-chunk limit. Split the file or delete other documents.`,
    )
  }
}

export function assertChatbotChunks(currentChunks: number, incomingChunks: number, caps: IngestCaps): void {
  if (currentChunks + incomingChunks > caps.maxChunksPerChatbot) {
    throw ingestCapError(
      409,
      "chunks",
      `This upload would exceed the ${caps.maxChunksPerChatbot}-chunk limit for this chatbot.`,
    )
  }
}

export async function incrementIngestRejectedCap(reason: IngestCapReason): Promise<void> {
  log().info({ event: "ingest.rejected_cap", metric: "ingest.rejected_cap", reason }, "ingest.rejected_cap")
  try {
    const day = new Date().toISOString().slice(0, 10)
    const key = `metric:ingest.rejected_cap.${reason}:${day}`
    const total = `metric:ingest.rejected_cap:${day}`
    await cacheRedis.incr(key)
    await cacheRedis.incr(total)
    await cacheRedis.expire(key, 3 * 24 * 60 * 60)
    await cacheRedis.expire(total, 3 * 24 * 60 * 60)
  } catch {
    // Metrics must never block ingest.
  }
}

export async function enforceIngestCap(check: () => void): Promise<void> {
  try {
    check()
  } catch (err) {
    if (err instanceof AppError && err.cap) {
      await incrementIngestRejectedCap(err.cap)
    }
    throw err
  }
}
