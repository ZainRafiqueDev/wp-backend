import { describe, expect, it } from "vitest"

import { documentStorageKey } from "../../src/lib/objectStorage.js"

describe("WP-2.1 object storage keys", () => {
  it("scopes keys to tenant, document, and a sanitized file name", () => {
    expect(documentStorageKey("bot-1", "doc-1", "Q3 Report (final).pdf")).toBe(
      "tenant/bot-1/documents/doc-1/Q3_Report_final_.pdf",
    )
  })

  it("falls back when the name is only punctuation", () => {
    expect(documentStorageKey("bot-1", "doc-1", "???")).toBe("tenant/bot-1/documents/doc-1/upload.bin")
  })
})
