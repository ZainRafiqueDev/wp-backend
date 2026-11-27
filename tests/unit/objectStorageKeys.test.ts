import { describe, expect, it } from "vitest"

const { documentStorageKey, putDocumentObject } = await import("../../src/lib/objectStorage.js")

describe("documentStorageKey", () => {
  it.each([".", "..", "...", "/..", "\..\\"])("never turns the filename %j into a path segment", (name) => {
    const key = documentStorageKey("bot", "doc", name)
    expect(key).toBe("tenant/bot/documents/doc/upload.bin")
  })

  it("keeps an ordinary filename readable", () => {
    expect(documentStorageKey("bot", "doc", "My Price List (2026).pdf")).toBe("tenant/bot/documents/doc/My_Price_List_2026_.pdf")
  })
})

describe("local storage paths", () => {
  it("refuses a key that would resolve outside the storage root", async () => {
    await expect(putDocumentObject("../../escape.txt", Buffer.from("x"))).rejects.toThrow(/Invalid storage key/)
  })
})
