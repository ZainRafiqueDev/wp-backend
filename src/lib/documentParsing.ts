import { spawn } from "node:child_process"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import mammoth from "mammoth"

import pdfParseModule from "pdf-parse"
import ExcelJS from "exceljs"

import { AppError } from "./errors.js"
import { env } from "../env.js"
import { log } from "./logger.js"

const pdfParse = (pdfParseModule as unknown as { default?: typeof pdfParseModule }).default ?? pdfParseModule

export type SupportedDocumentType = "pdf" | "docx" | "txt" | "md" | "csv" | "xlsx"

const EXTENSION_TO_TYPE: Record<string, SupportedDocumentType> = {
  pdf: "pdf",
  docx: "docx",
  txt: "txt",
  md: "md",
  markdown: "md",
  csv: "csv",
  xlsx: "xlsx",
}

export function detectDocumentType(fileName: string): SupportedDocumentType {
  const ext = fileName.split(".").pop()?.toLowerCase() ?? ""
  const type = EXTENSION_TO_TYPE[ext]
  console.log(`[documentParsing] detectDocumentType: fileName="${fileName}" ext="${ext}" -> type=${type ?? "UNSUPPORTED"}`)
  if (!type) {
    throw new AppError(400, `Unsupported file type ".${ext}". Allowed: PDF, DOCX, TXT, MD, CSV, XLSX.`)
  }
  return type
}

async function extractFromXlsx(buffer: Buffer): Promise<string> {
  const workbook = new ExcelJS.Workbook()
  // exceljs's own .d.ts declares a Buffer shape that doesn't structurally
  // match @types/node's generic Buffer<ArrayBufferLike>, even after an `as
  // Buffer` cast; same for the pdf-parse call below.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await workbook.xlsx.load(buffer as any)
  const parts: string[] = []
  workbook.eachSheet((sheet) => {
    parts.push(`--- Sheet: ${sheet.name} ---`)
    sheet.eachRow((row) => {
      const cells = (row.values as unknown[]).slice(1).map((v) => (v === null || v === undefined ? "" : String(v)))
      parts.push(cells.join(", "))
    })
  })
  return parts.join("\n")
}

export type ExtractionMethod = "text" | "ocr"

export async function extractText(buffer: Buffer, type: SupportedDocumentType): Promise<string> {
  const result = await extractTextWithMethod(buffer, type)
  return result.text
}

export async function extractTextWithMethod(
  buffer: Buffer,
  type: SupportedDocumentType,
): Promise<{ text: string; method: ExtractionMethod }> {
  console.log(`[documentParsing] extractText: type=${type} bufferSize=${buffer.length} bytes`)
  try {
    let text: string
    switch (type) {
      case "pdf": {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see the comment on the exceljs call above
        const result = await pdfParse(buffer as any)
        text = result.text
        break
      }
      case "docx": {
        const result = await mammoth.extractRawText({ buffer })
        text = result.value
        break
      }
      case "xlsx": {
        text = await extractFromXlsx(buffer)
        break
      }
      case "txt":
      case "md":
      case "csv":
        text = buffer.toString("utf-8")
        break
    }
    const trimmed = text.trim()
    console.log(`[documentParsing] extractText: type=${type} extracted ${trimmed.length} chars`)
    if (trimmed) return { text: trimmed, method: "text" }

    if (type === "pdf" && env.documentOcrEnabled) {
      const ocr = await ocrPdfWithTesseract(buffer)
      if (ocr.trim()) return { text: ocr.trim(), method: "ocr" }
    }

    throw new AppError(422, "Couldn't extract any text from this file — it may be empty, scanned/image-only, or corrupted.")
  } catch (err) {
    if (err instanceof AppError) throw err
    console.error(`[documentParsing] extractText FAILED: type=${type}`, err)
    throw new AppError(422, "Couldn't read this file. Make sure it isn't corrupted or password-protected.")
  }
}

const OCR_TIMEOUT_MS = 60_000
const OCR_MAX_OUTPUT_CHARS = 5_000_000

async function ocrPdfWithTesseract(buffer: Buffer): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "chatmate360-ocr-"))
  const input = join(dir, "page.pdf")
  try {
    await writeFile(input, buffer)
    const text = await new Promise<string>((resolve, reject) => {
      // Untrusted input: bound both wall-clock time and output size so a
      // hostile or pathological file cannot pin a CPU or grow memory without
      // limit. spawn() with an argument array never goes through a shell.
      const child = spawn("tesseract", [input, "stdout"], { windowsHide: true, timeout: OCR_TIMEOUT_MS, killSignal: "SIGKILL" })
      let stdout = ""
      let stderr = ""
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8")
        if (stdout.length > OCR_MAX_OUTPUT_CHARS) {
          child.kill("SIGKILL")
          reject(new Error(`tesseract output exceeded ${OCR_MAX_OUTPUT_CHARS} chars`))
        }
      })
      child.stderr.on("data", (chunk: Buffer) => {
        if (stderr.length < 4096) stderr += chunk.toString("utf8")
      })
      child.on("error", reject)
      child.on("close", (code, signal) => {
        if (code === 0) resolve(stdout)
        else reject(new Error(signal ? `tesseract killed (${signal}), likely the ${OCR_TIMEOUT_MS}ms timeout` : stderr || `tesseract exited ${code}`))
      })
    })
    return text
  } catch (err) {
    log().warn(
      { err: err instanceof Error ? err.message : String(err), event: "ingest.ocr_failed" },
      "tesseract OCR fallback failed",
    )
    return ""
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}
