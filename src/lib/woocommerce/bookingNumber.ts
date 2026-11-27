import { randomInt } from "node:crypto"

const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
const LENGTH = 6

export function generateBookingNumberCandidate(): string {
  let suffix = ""
  for (let i = 0; i < LENGTH; i++) {
    suffix += ALPHABET[randomInt(ALPHABET.length)]
  }
  return `CM-${suffix}`
}
