import { completeCheaply, type AiUsage } from "./ai.js"
import { cheapCallAuthorizer } from "./cheapCallBilling.js"
import { env } from "../env.js"
import { chatMessageSummary, log } from "./logger.js"
import { recordUsage } from "../services/usage.service.js"

interface ChatMessage {
  role: "user" | "assistant"
  content: string
}

const MAX_REWRITTEN_LENGTH = 150

function rewritePrompt(historyBlock: string, rawQuery: string): string {
  return `You are a search query optimizer for a customer support AI.

Given the conversation history and the customer's latest message,
rewrite the query into a single, standalone search query that:
1. Is semantically complete (can be understood without the conversation)
2. Expands abbreviations and informal language
3. Incorporates relevant context from prior turns
4. Removes filler words and greetings
5. Focuses on the information need

Conversation history:
${historyBlock || "(none)"}

Customer's latest message:
${rawQuery}

Output ONLY the rewritten query. No explanation. No preamble.
If the message needs no rewriting (it's already clear), output it unchanged.
Maximum length: ${MAX_REWRITTEN_LENGTH} characters.`
}

/**
 * WP-3.1 query rewriting. Returns null (never throws) when rewriting isn't
 * possible or didn't help — callers fall back to their own cheaper
 * heuristic (answerChatbotQuestion.ts's buildRetrievalQuery), never to a
 * broken request. Only ever called with the customer's own message history
 * — never system messages or tool calls, since `history` here is always
 * the plain user/assistant chat transcript.
 */
export async function rewriteQueryForRetrieval(
  chatbotId: string,
  question: string,
  history: ChatMessage[],
): Promise<string | null> {
  // Nothing to resolve a pronoun or fragment against on the first turn of a
  // conversation — skip the LLM call entirely rather than spend cost and
  // latency rewriting a query that has no prior context to incorporate.
  if (history.length === 0) return null

  const historyBlock = history
    .slice(-4)
    .map((message) => `${message.role}: ${message.content.trim().slice(0, 500)}`)
    .join("\n")

  try {
    const usageSink: AiUsage[] = []
    const raw = await completeCheaply(rewritePrompt(historyBlock, question), "Output the rewritten query now.", usageSink, cheapCallAuthorizer(chatbotId))
    // Rewriting cost is charged to tenant credits, same as any other AI call.
    if (usageSink.length > 0) await recordUsage(chatbotId, usageSink)

    const rewritten = raw?.trim().slice(0, MAX_REWRITTEN_LENGTH)
    if (!rewritten) {
      log().warn({ chatbotId }, "query rewrite returned nothing, falling back")
      return null
    }

    log().info(
      { chatbotId, ...chatMessageSummary(question), changed: rewritten !== question.trim() },
      "query rewritten for retrieval",
    )
    // Same production-gating as chatMessageDebugField in logger.ts — never
    // both raw and rewritten message content in prod logs, even at debug
    // level.
    if (env.nodeEnv !== "production") {
      log().debug({ chatbotId, rawQuery: question, rewrittenQuery: rewritten }, "query rewrite detail")
    }
    return rewritten
  } catch (err) {
    log().warn({ chatbotId, err: err instanceof Error ? err.message : String(err) }, "query rewrite failed, falling back")
    return null
  }
}
