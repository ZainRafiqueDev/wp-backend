import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"

import { env, hasIntegrationEncryption } from "../env.js"

const ALGORITHM = "aes-256-gcm"
const IV_BYTES = 12
// GCM tag length is pinned on both sides (and checked before decrypting) so a
// truncated tag can never be accepted: Node otherwise accepts tags as short
// as 4 bytes, which makes forging ciphertexts far easier.
const AUTH_TAG_BYTES = 16

function keyBuffer(): Buffer {
  if (!hasIntegrationEncryption) {
    throw new Error(
      "INTEGRATION_ENCRYPTION_KEY must be set (32 bytes, hex-encoded) to store integration credentials.",
    )
  }
  return Buffer.from(env.integrationEncryptionKey, "hex")
}


export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, keyBuffer(), iv, { authTagLength: AUTH_TAG_BYTES })
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()])
  const authTag = cipher.getAuthTag()
  return `${iv.toString("hex")}:${authTag.toString("hex")}:${ciphertext.toString("hex")}`
}

export function decryptSecret(payload: string): string {
  const [ivHex, authTagHex, ciphertextHex] = payload.split(":")
  if (!ivHex || !authTagHex || !ciphertextHex) {
    throw new Error("Malformed encrypted payload.")
  }
  const iv = Buffer.from(ivHex, "hex")
  const authTag = Buffer.from(authTagHex, "hex")
  if (iv.length !== IV_BYTES || authTag.length !== AUTH_TAG_BYTES) {
    throw new Error("Malformed encrypted payload.")
  }
  const decipher = createDecipheriv(ALGORITHM, keyBuffer(), iv, { authTagLength: AUTH_TAG_BYTES })
  decipher.setAuthTag(authTag)
  const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertextHex, "hex")), decipher.final()])
  return plaintext.toString("utf8")
}
