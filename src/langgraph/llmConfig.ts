// NEW-01: shared by llm.ts (the client) and billedLlm.ts (the reservation
// estimate), kept separate so tests that mock llm.js still see these.
export const COMMERCE_LLM_MODEL = "gpt-4o-mini"

// Bounds a single graph call's spend so the pre-call reservation covers it;
// same per-call output ceiling as the main answer path (ai.ts max_tokens 800).
// Graph replies are one-word classifications, small JSON objects or short
// product answers, all far below this.
export const COMMERCE_LLM_MAX_OUTPUT_TOKENS = 800
