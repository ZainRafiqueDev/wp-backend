import { describe, expect, it } from "vitest"

import { env } from "../../src/env.js"
import { AppError } from "../../src/lib/errors.js"
import {
  assertChatbotBytes,
  assertChatbotChunks,
  assertDocumentChunks,
  assertDocumentCount,
  assertFileBytes,
  resolveIngestCaps,
  resolveIngestCapsForPlan,
} from "../../src/lib/ingestCaps.js"

const caps = resolveIngestCaps()

describe("ingestCaps", () => {
  it("uses env defaults when chatbot overrides are null", () => {
    expect(caps.maxDocuments).toBe(env.documentMaxPerChatbot)
    expect(caps.maxFileBytes).toBe(env.documentMaxFileBytes)
    expect(caps.maxChatbotBytes).toBe(env.documentMaxChatbotBytes)
    expect(caps.maxChunksPerDocument).toBe(env.documentMaxChunksPerDocument)
    expect(caps.maxChunksPerChatbot).toBe(env.documentMaxChunksPerChatbot)
  })

  it("applies positive chatbot overrides for documents, bytes, and chunks", () => {
    const overridden = resolveIngestCaps({
      maxDocuments: 10,
      maxBytes: 8 * 1024 * 1024,
      maxChunks: 50,
    })
    expect(overridden.maxDocuments).toBe(10)
    expect(overridden.maxChatbotBytes).toBe(8 * 1024 * 1024)
    expect(overridden.maxChunksPerChatbot).toBe(50)
    expect(overridden.maxFileBytes).toBe(caps.maxFileBytes)
    expect(overridden.maxChunksPerDocument).toBe(caps.maxChunksPerDocument)
  })

  it("ignores non-positive overrides so a bad column cannot disable ingest", () => {
    const ignored = resolveIngestCaps({ maxDocuments: 0, maxBytes: -1, maxChunks: Number.NaN })
    expect(ignored.maxDocuments).toBe(caps.maxDocuments)
    expect(ignored.maxChatbotBytes).toBe(caps.maxChatbotBytes)
    expect(ignored.maxChunksPerChatbot).toBe(caps.maxChunksPerChatbot)
  })

  it("rejects the 26th document with cap=documents", () => {
    expect(() => assertDocumentCount(25, caps)).toThrow(AppError)
    try {
      assertDocumentCount(25, caps)
    } catch (err) {
      expect(err).toMatchObject({
        status: 409,
        cap: "documents",
        code: "DOC_LIMIT_REACHED",
        data: { used: 25, limit: caps.maxDocuments },
      })
    }
  })

  it("rejects an oversize file with 413 FILE_TOO_LARGE", () => {
    try {
      assertFileBytes(caps.maxFileBytes + 1, caps)
      throw new Error("expected cap error")
    } catch (err) {
      expect(err).toMatchObject({
        status: 413,
        cap: "bytes",
        code: "FILE_TOO_LARGE",
        data: { limit: caps.maxFileBytes },
      })
    }
  })

  it("rejects a chatbot-byte overflow with cap=bytes", () => {
    try {
      assertChatbotBytes(caps.maxChatbotBytes, 1, caps)
      throw new Error("expected cap error")
    } catch (err) {
      expect(err).toMatchObject({
        status: 409,
        cap: "bytes",
        code: "DOC_LIMIT_REACHED",
        data: { used: caps.maxChatbotBytes, limit: caps.maxChatbotBytes },
      })
    }
  })

  it("rejects a per-document chunk explosion with cap=chunks", () => {
    try {
      assertDocumentChunks(caps.maxChunksPerDocument + 1, caps)
      throw new Error("expected cap error")
    } catch (err) {
      expect(err).toMatchObject({ status: 409, cap: "chunks" })
    }
  })

  it("rejects a chatbot chunk overflow with cap=chunks", () => {
    try {
      assertChatbotChunks(caps.maxChunksPerChatbot, 1, caps)
      throw new Error("expected cap error")
    } catch (err) {
      expect(err).toMatchObject({ status: 409, cap: "chunks" })
    }
  })

  it("allows an upload that lands exactly on the chatbot byte and chunk caps", () => {
    expect(() => assertChatbotBytes(caps.maxChatbotBytes - 100, 100, caps)).not.toThrow()
    expect(() => assertChatbotChunks(caps.maxChunksPerChatbot - 3, 3, caps)).not.toThrow()
    expect(() => assertDocumentChunks(caps.maxChunksPerDocument, caps)).not.toThrow()
    expect(() => assertDocumentCount(24, caps)).not.toThrow()
    expect(() => assertFileBytes(caps.maxFileBytes, caps)).not.toThrow()
  })
})

describe("resolveIngestCapsForPlan", () => {
  const crawlPlusPlanCaps = { maxDocuments: 6, maxFileSizeBytes: 16 * 1024 * 1024, maxChatbotBytes: 50 * 1024 * 1024 }

  it("uses the plan's own numbers when there is no chatbot override", () => {
    const resolved = resolveIngestCapsForPlan(crawlPlusPlanCaps)
    expect(resolved.maxDocuments).toBe(6)
    expect(resolved.maxFileBytes).toBe(16 * 1024 * 1024)
    expect(resolved.maxChatbotBytes).toBe(50 * 1024 * 1024)
  })

  it("lets a per-chatbot override win over the plan default for documents and total bytes", () => {
    const resolved = resolveIngestCapsForPlan(crawlPlusPlanCaps, {
      maxDocuments: 20,
      maxBytes: 200 * 1024 * 1024,
      maxChunks: null,
    })
    expect(resolved.maxDocuments).toBe(20)
    expect(resolved.maxChatbotBytes).toBe(200 * 1024 * 1024)
    // Per-file size is never overridden per-chatbot.
    expect(resolved.maxFileBytes).toBe(16 * 1024 * 1024)
  })

  it("two different plans resolve to two different caps", () => {
    const fullCustomPlanCaps = {
      maxDocuments: env.documentMaxPerChatbot,
      maxFileSizeBytes: env.documentMaxFileBytes,
      maxChatbotBytes: env.documentMaxChatbotBytes,
    }
    const crawlPlus = resolveIngestCapsForPlan(crawlPlusPlanCaps)
    const fullCustom = resolveIngestCapsForPlan(fullCustomPlanCaps)
    expect(crawlPlus.maxDocuments).not.toBe(fullCustom.maxDocuments)
    expect(crawlPlus.maxFileBytes).not.toBe(fullCustom.maxFileBytes)
  })
})
