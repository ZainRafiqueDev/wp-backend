import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join, resolve, sep } from "node:path"

import { env } from "../env.js"
import { AppError } from "./errors.js"
import { log } from "./logger.js"

export function documentStorageKey(chatbotId: string, documentId: string, fileName: string): string {
  const cleaned = fileName.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^[_-]+|[_-]+$/g, "").slice(0, 180)
  // A name made only of dots ("." / "..") would be a path segment, not a file.
  const safeName = /^\.*$/.test(cleaned) ? "upload.bin" : cleaned
  return `tenant/${chatbotId}/documents/${documentId}/${safeName}`
}

// Phase 3: generatedFileName is already an opaque generated id + extension
// (never the visitor's own filename — see chatAttachments.service.ts), so
// no sanitizing pass is needed the way documentStorageKey needs one for a
// customer-supplied name.
export function attachmentStorageKey(chatbotId: string, attachmentId: string, generatedFileName: string): string {
  return `tenant/${chatbotId}/attachments/${attachmentId}/${generatedFileName}`
}

function fsPathForKey(key: string): string {
  const root = resolve(env.documentStorageDir)
  const path = resolve(join(root, key.replace(/\\/g, "/")))
  // Defense in depth: no key may resolve outside the storage root.
  if (path !== root && !path.startsWith(root + sep)) {
    throw new AppError(400, "Invalid storage key.")
  }
  return path
}

async function putFs(key: string, body: Buffer): Promise<void> {
  const path = fsPathForKey(key)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, body)
}

async function getFs(key: string): Promise<Buffer> {
  try {
    return await readFile(fsPathForKey(key))
  } catch {
    throw new AppError(404, "Stored document bytes were not found.")
  }
}

async function deleteFs(key: string): Promise<void> {
  await rm(fsPathForKey(key), { force: true })
}

async function s3Client() {
  const { S3Client } = await import("@aws-sdk/client-s3")
  if (!env.documentStorageBucket) {
    throw new AppError(503, "Document object storage is not configured. Set DOCUMENT_STORAGE_BUCKET.")
  }
  return new S3Client({
    region: env.documentStorageRegion,
    endpoint: env.documentStorageEndpoint || undefined,
    forcePathStyle: Boolean(env.documentStorageEndpoint),
    credentials:
      env.documentStorageAccessKey && env.documentStorageSecretKey
        ? { accessKeyId: env.documentStorageAccessKey, secretAccessKey: env.documentStorageSecretKey }
        : undefined,
  })
}

async function putS3(key: string, body: Buffer): Promise<void> {
  const { PutObjectCommand } = await import("@aws-sdk/client-s3")
  const client = await s3Client()
  await client.send(
    new PutObjectCommand({
      Bucket: env.documentStorageBucket,
      Key: key,
      Body: body,
    }),
  )
}

async function getS3(key: string): Promise<Buffer> {
  const { GetObjectCommand } = await import("@aws-sdk/client-s3")
  const client = await s3Client()
  try {
    const result = await client.send(new GetObjectCommand({ Bucket: env.documentStorageBucket, Key: key }))
    const bytes = await result.Body?.transformToByteArray()
    if (!bytes) throw new AppError(404, "Stored document bytes were not found.")
    return Buffer.from(bytes)
  } catch (err) {
    if (err instanceof AppError) throw err
    throw new AppError(404, "Stored document bytes were not found.")
  }
}

async function deleteS3(key: string): Promise<void> {
  const { DeleteObjectCommand } = await import("@aws-sdk/client-s3")
  const client = await s3Client()
  await client.send(new DeleteObjectCommand({ Bucket: env.documentStorageBucket, Key: key }))
}

export async function putDocumentObject(key: string, body: Buffer): Promise<void> {
  if (env.documentStorageDriver === "s3") {
    await putS3(key, body)
    return
  }
  await putFs(key, body)
}

export async function getDocumentObject(key: string): Promise<Buffer> {
  if (env.documentStorageDriver === "s3") return getS3(key)
  return getFs(key)
}

export async function deleteDocumentObject(key: string): Promise<void> {
  try {
    if (env.documentStorageDriver === "s3") await deleteS3(key)
    else await deleteFs(key)
  } catch (err) {
    log().warn({ key, err: err instanceof Error ? err.message : String(err) }, "document object delete failed")
  }
}
