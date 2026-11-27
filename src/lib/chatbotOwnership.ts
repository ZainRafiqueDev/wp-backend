import { pool } from "./db.js"
import { AppError } from "./errors.js"
import { setTenantContext } from "./tenantContext.js"


export async function requireOwnedChatbotId(userId: string, chatbotId: string): Promise<string> {
  if (!pool) {
    throw new AppError(503, "Database is not configured. Set DATABASE_URL and JWT_SECRET.")
  }
  setTenantContext({ scope: "user", userId })
  const { rows } = await pool.query<{ id: string }>(
    "select id from chatbots where id = $1 and user_id = $2",
    [chatbotId, userId],
  )
  if (!rows[0]) throw new AppError(404, "Chatbot not found.")
  setTenantContext({ chatbotId: rows[0].id })
  return rows[0].id
}
