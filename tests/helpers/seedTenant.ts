import { randomUUID } from "node:crypto"

import { testAccessToken } from "./testSession.js"
import { pool } from "../../src/lib/db.js"

export type SeededTenant = {
  userId: string
  chatbotId: string
  token: string
}

export async function seedOwnedChatbot(
  label: string,
  plan: "free" | "crawl_plus" | "full_custom" = "crawl_plus",
): Promise<SeededTenant> {
  if (!pool) throw new Error("seedOwnedChatbot requires TEST_DATABASE_URL / DATABASE_URL")

  const user = await pool.query<{ id: string }>(
    `insert into users (email, password_hash, name, email_verified) values ($1, 'x', $2, true) returning id`,
    [`${label}-${randomUUID()}@example.test`, label],
  )
  const bot = await pool.query<{ id: string }>(
    `insert into chatbots (user_id, name, sources, status) values ($1, $2, '[]', 'ready') returning id`,
    [user.rows[0].id, `${label} bot`],
  )
  if (plan !== "free") {
    await pool.query(
      `insert into subscriptions (user_id, stripe_customer_id, plan, status) values ($1, $2, $3, 'active')`,
      [user.rows[0].id, `cus_${label}_${randomUUID()}`, plan],
    )
  }
  return {
    userId: user.rows[0].id,
    chatbotId: bot.rows[0].id,
    token: await testAccessToken(user.rows[0].id),
  }
}

export function authed(token: string) {
  return { Authorization: `Bearer ${token}` }
}
