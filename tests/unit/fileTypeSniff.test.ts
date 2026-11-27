import { describe, expect, it } from "vitest"

import { sniffAttachmentType } from "../../src/lib/fileTypeSniff.js"

describe("sniffAttachmentType", () => {
  it("detects png from its real signature", () => {
    const buf = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from([1, 2, 3])])
    expect(sniffAttachmentType(buf)).toBe("png")
  })

  it("detects jpg from its real signature", () => {
    const buf = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])
    expect(sniffAttachmentType(buf)).toBe("jpg")
  })

  it("detects webp from RIFF....WEBP", () => {
    const buf = Buffer.concat([Buffer.from("RIFF", "ascii"), Buffer.from([0, 0, 0, 0]), Buffer.from("WEBP", "ascii"), Buffer.from([1, 2])])
    expect(sniffAttachmentType(buf)).toBe("webp")
  })

  it("detects pdf from %PDF-", () => {
    const buf = Buffer.from("%PDF-1.7\n...", "ascii")
    expect(sniffAttachmentType(buf)).toBe("pdf")
  })

  it("detects plain valid UTF-8 text", () => {
    const buf = Buffer.from("Hello, world — café ☕", "utf8")
    expect(sniffAttachmentType(buf)).toBe("txt")
  })

  it("rejects a renamed executable (PE header) masquerading as any allowed type", () => {
    const peHeader = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00])
    expect(sniffAttachmentType(peHeader)).toBeNull()
  })

  it("rejects binary content with a null byte claiming to be .txt", () => {
    const buf = Buffer.from([0x41, 0x42, 0x00, 0x43])
    expect(sniffAttachmentType(buf)).toBeNull()
  })

  it("rejects invalid UTF-8 byte sequences claiming to be .txt", () => {
    const buf = Buffer.from([0xff, 0xfe, 0x00, 0x41])
    expect(sniffAttachmentType(buf)).toBeNull()
  })

  it("rejects an empty buffer", () => {
    expect(sniffAttachmentType(Buffer.alloc(0))).toBeNull()
  })

  it("rejects a jpg-claiming file whose bytes don't actually match the jpg signature", () => {
    const buf = Buffer.from("not actually a jpeg, just text with .jpg in the filename")
    // This is genuinely valid UTF-8 text, so it correctly sniffs as txt —
    // proving detection goes by content, never by what the uploader claims.
    expect(sniffAttachmentType(buf)).toBe("txt")
  })
})
