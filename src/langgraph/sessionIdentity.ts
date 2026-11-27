import { getBooklyGraph } from "./booklyGraph.js"
import { booklyThreadId } from "./booklyEntrypoint.js"
import { getCommerceGraph } from "./commerceGraph.js"
import { commerceThreadId } from "./commerceEntrypoint.js"
import { verifiedCustomerFromThreadValues } from "./customerVerificationNodes.js"

/**
 * CS-04: the customer this chat session has proved it owns (OTP in either
 * graph), for this chatbot only, or null. `sessionKey` must come from a
 * server-issued session (customerSession.service chatSessionKey).
 */
export async function verifiedCustomerForChatSession(chatbotId: string, sessionKey: string): Promise<string | null> {
  const commerce = await (await getCommerceGraph()).getState({ configurable: { thread_id: commerceThreadId(chatbotId, sessionKey) } })
  const fromCommerce = verifiedCustomerFromThreadValues(commerce.values, chatbotId)
  if (fromCommerce) return fromCommerce
  const bookly = await (await getBooklyGraph()).getState({ configurable: { thread_id: booklyThreadId(chatbotId, sessionKey) } })
  return verifiedCustomerFromThreadValues(bookly.values, chatbotId)
}
