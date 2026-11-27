// Phase 3 (2026-10-27): content-based type detection for chat attachments,
// in-house — no new dependency. Checked against the file's actual bytes,
// never the client-supplied filename/extension/Content-Type (all
// trivially spoofable), matching the condition this was built under:
// "detect type from file content (not extension)."
export type SniffedAttachmentType = "png" | "jpg" | "webp" | "pdf" | "txt"

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff])
const PDF_SIGNATURE = Buffer.from("%PDF-", "ascii")
const RIFF_SIGNATURE = Buffer.from("RIFF", "ascii")
const WEBP_SIGNATURE = Buffer.from("WEBP", "ascii")

function startsWith(buffer: Buffer, signature: Buffer): boolean {
  return buffer.length >= signature.length && buffer.subarray(0, signature.length).equals(signature)
}

function isWebp(buffer: Buffer): boolean {
  // RIFF <4-byte size> WEBP — the size field (bytes 4-7) is irrelevant to
  // the type check, only the two fixed markers around it matter.
  return (
    buffer.length >= 12 &&
    startsWith(buffer, RIFF_SIGNATURE) &&
    buffer.subarray(8, 12).equals(WEBP_SIGNATURE)
  )
}

// Valid, printable-enough UTF-8 with no embedded null bytes — a null byte
// is the one thing that reliably never belongs in a genuine text file and
// is cheap to reject outright (binary content masquerading as .txt).
function isPlausibleUtf8Text(buffer: Buffer): boolean {
  if (buffer.length === 0) return false
  if (buffer.includes(0x00)) return false
  const decoded = buffer.toString("utf8")
  // Round-trip check: re-encoding the decoded string must reproduce the
  // original bytes exactly. Buffer#toString("utf8") silently substitutes
  // U+FFFD for invalid sequences instead of throwing, so a byte-for-byte
  // comparison after re-encoding is what actually catches non-UTF-8 input.
  return Buffer.from(decoded, "utf8").equals(buffer)
}

// Returns the sniffed type, or null if the content doesn't match any
// allowed type's real signature — the caller rejects on null, regardless
// of what the client claimed.
export function sniffAttachmentType(buffer: Buffer): SniffedAttachmentType | null {
  if (startsWith(buffer, PNG_SIGNATURE)) return "png"
  if (startsWith(buffer, JPEG_SIGNATURE)) return "jpg"
  if (isWebp(buffer)) return "webp"
  if (startsWith(buffer, PDF_SIGNATURE)) return "pdf"
  // Text is checked last — it's the only type with no fixed byte signature,
  // so it must never be allowed to shadow a corrupt/truncated binary file
  // that happens to decode as UTF-8 by accident over its first bytes; the
  // full-buffer round-trip check above already handles that correctly, but
  // ordering still keeps the unambiguous binary signatures first on principle.
  if (isPlausibleUtf8Text(buffer)) return "txt"
  return null
}

export const CONTENT_TYPE_FOR_SNIFFED_TYPE: Record<SniffedAttachmentType, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  webp: "image/webp",
  pdf: "application/pdf",
  txt: "text/plain",
}
