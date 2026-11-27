import "dotenv/config"

import { answerChatbotQuestion } from "../src/lib/answerChatbotQuestion.js"
import { bumpChatbotCacheVersion } from "../src/lib/cache.js"
import { defaultFallbackMessage, type ChatbotSource } from "../src/lib/chatbot.js"
import { pool } from "../src/lib/db.js"
import { redis } from "../src/lib/redis.js"

const id = "c72f2a4c-97d8-44b1-9275-d1f913bfc2d4"

await bumpChatbotCacheVersion(id)
const keys = await redis.keys("answer:*")
const rel = await redis.keys("relevance:*")
if (keys.length) await redis.del(...keys)
if (rel.length) await redis.del(...rel)

const { rows } = await pool!.query(
  "select name, sources, fallback_message, preferred_model from chatbots where id = $1",
  [id],
)
const bot = rows[0]
const sources = bot.sources as ChatbotSource[]
const queries = ["what is web dev", "What is web development?", "do you build websites?", "what is the weather?"]

for (const q of queries) {
  const a = await answerChatbotQuestion(
    id,
    bot.name as string,
    sources,
    q,
    [],
    (bot.fallback_message as string) || defaultFallbackMessage(bot.name as string),
    [],
    undefined,
    bot.preferred_model as "anthropic" | "openai" | "gemini" | null,
  )
  console.log("Q:", q)
  console.log("A:", a.text)
  console.log("ai=", a.aiGenerated, "gate=", a.gateReason ?? null)
  console.log("---")
}

await redis.quit()
await pool!.end()
