import { ChatOpenAI } from "@langchain/openai"

import { env, hasProductEmbeddings } from "../env.js"
import { COMMERCE_LLM_MAX_OUTPUT_TOKENS, COMMERCE_LLM_MODEL } from "./llmConfig.js"

let client: ChatOpenAI | null = null

export function hasCommerceLlm(): boolean {
  return hasProductEmbeddings // same underlying key (OPENAI_API_KEY)
}

// NEW-01: graph nodes must not call this client directly — use
// invokeBilledCommerceLlm (billedLlm.ts), which reserves and records usage.
export function getCommerceLlm(): ChatOpenAI {
  if (!client) {
    client = new ChatOpenAI({ apiKey: env.openaiApiKey, model: COMMERCE_LLM_MODEL, temperature: 0, maxTokens: COMMERCE_LLM_MAX_OUTPUT_TOKENS })
  }
  return client
}
