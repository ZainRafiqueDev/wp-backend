import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { isDemoSandbox } from "../env.js"
import { AppError } from "../lib/errors.js"

type DemoReply = {
  keywords: string[]
  reply: string
}

const FALLBACK =
  "This is a sandbox demo. I can talk about orders, pricing, trials, and how Chatmate360 works — no live customer data is used."

const replies = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../data/demo-replies.json"), "utf8"),
) as DemoReply[]

const cache = new Map<string, string>()

function normalize(value: string) {
  return value.toLowerCase().replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim()
}

export function replyToDemoMessage(message: string) {
  if (!isDemoSandbox) {
    throw new AppError(403, "Demo chat is locked to sandbox mode and cannot run against live data.")
  }

  const key = normalize(message)
  const cached = cache.get(key)
  if (cached) {
    return { reply: cached, cached: true, sandbox: true as const }
  }

  const match = replies.find((item) => item.keywords.some((keyword) => key.includes(keyword)))
  const reply = match?.reply ?? FALLBACK
  // Audit 2026-11-27: keyed by anonymous input, so bound it (it used to grow without limit).
  if (cache.size >= 500) cache.clear()
  cache.set(key, reply)

  return { reply, cached: false, sandbox: true as const }
}
