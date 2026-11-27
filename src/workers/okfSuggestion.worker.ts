import { suggestOKFConcepts } from "../services/okfSuggestion.service.js"

/** WP-5.3 extraction entrypoint. Called from the ingest worker after finalize. */
export async function runOkfSuggestionWorker(documentId: string, chatbotId: string): Promise<number> {
  return suggestOKFConcepts(documentId, chatbotId)
}
