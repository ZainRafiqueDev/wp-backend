
import { pool } from "../lib/db.js"
import { AppError } from "../lib/errors.js"

export type VerificationLevel = "UNVERIFIED" | "EMAIL_VERIFIED" | "ORDER_VERIFIED" | "ACCOUNT_VERIFIED"


export const VERIFICATION_LEVEL_RANK: Record<VerificationLevel, number> = {
  UNVERIFIED: 0,
  EMAIL_VERIFIED: 1,
  ORDER_VERIFIED: 2,
  ACCOUNT_VERIFIED: 3,
}

export interface CustomerIdentity {
  id: string
  chatbotId: string
  email: string | null
  phone: string | null
  woocommerceCustomerId: string | null
  verificationLevel: VerificationLevel
  createdAt: string
}

function requireDbPool() {
  if (!pool) throw new AppError(503, "Database is not configured. Set DATABASE_URL and JWT_SECRET.")
  return pool
}

function mapRow(row: Record<string, unknown>): CustomerIdentity {
  return {
    id: row.id as string,
    chatbotId: row.chatbot_id as string,
    email: (row.email as string | null) ?? null,
    phone: (row.phone as string | null) ?? null,
    woocommerceCustomerId: (row.woocommerce_customer_id as string | null) ?? null,
    verificationLevel: row.verification_level as VerificationLevel,
    createdAt: (row.created_at as Date).toISOString(),
  }
}


export async function resolveCustomerIdentity(chatbotId: string, email: string, phone?: string | null): Promise<CustomerIdentity> {
  const db = requireDbPool()
  const normalizedEmail = email.trim().toLowerCase()

  const { rows: existing } = await db.query("select * from customer_identities where chatbot_id = $1 and email = $2", [chatbotId, normalizedEmail])
  if (existing[0]) {
    if (phone && !existing[0].phone) {
      const { rows: updated } = await db.query("update customer_identities set phone = $1 where id = $2 returning *", [phone, existing[0].id])
      return mapRow(updated[0])
    }
    return mapRow(existing[0])
  }

  const { rows } = await db.query(
    "insert into customer_identities (chatbot_id, email, phone) values ($1, $2, $3) returning *",
    [chatbotId, normalizedEmail, phone ?? null],
  )
  return mapRow(rows[0])
}

/** Look up (never create) the identity for this chatbot + email. */
export async function findCustomerIdentity(chatbotId: string, email: string): Promise<CustomerIdentity | null> {
  const db = requireDbPool()
  const { rows } = await db.query("select * from customer_identities where chatbot_id = $1 and email = $2", [chatbotId, email.trim().toLowerCase()])
  return rows[0] ? mapRow(rows[0]) : null
}

export async function getCustomerIdentity(customerId: string): Promise<CustomerIdentity | null> {
  const db = requireDbPool()
  const { rows } = await db.query("select * from customer_identities where id = $1", [customerId])
  return rows[0] ? mapRow(rows[0]) : null
}


export async function customerBelongsToChatbot(customerId: string, chatbotId: string): Promise<boolean> {
  const db = requireDbPool()
  const { rows } = await db.query("select 1 from customer_identities where id = $1 and chatbot_id = $2", [customerId, chatbotId])
  return rows.length > 0
}


export async function getVerificationLevel(customerId: string): Promise<VerificationLevel> {
  const db = requireDbPool()
  const { rows } = await db.query<{ verification_level: VerificationLevel }>(
    "select verification_level from customer_identities where id = $1",
    [customerId],
  )
  return rows[0]?.verification_level ?? "UNVERIFIED"
}


export async function promoteVerificationLevel(customerId: string, level: VerificationLevel): Promise<void> {
  const db = requireDbPool()
  await db.query(
    `update customer_identities
     set verification_level = $1
     where id = $2 and $3 > case verification_level
       when 'ACCOUNT_VERIFIED' then 3 when 'ORDER_VERIFIED' then 2 when 'EMAIL_VERIFIED' then 1 else 0 end`,
    [level, customerId, VERIFICATION_LEVEL_RANK[level]],
  )
}
