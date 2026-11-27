
export type LiveDataEntry = {
  id: string
  chatbotId: string
  key: string
  value: string
  updatedAt: string
}

export function liveDataRowToEntry(row: {
  id: string
  chatbot_id: string
  key: string
  value: string
  updated_at: Date
}): LiveDataEntry {
  return {
    id: row.id,
    chatbotId: row.chatbot_id,
    key: row.key,
    value: row.value,
    updatedAt: row.updated_at.toISOString(),
  }
}
