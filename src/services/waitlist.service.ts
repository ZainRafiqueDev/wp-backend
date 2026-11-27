import { pool } from "../lib/db.js"
import { AppError } from "../lib/errors.js"

export async function addToWaitlist(email: string) {
  if (!pool) {
    throw new AppError(503, "Database is not configured. Set DATABASE_URL and JWT_SECRET.")
  }

  try {
    await pool.query("insert into waitlist (email) values ($1)", [email])
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new AppError(409, "This email is already on the waitlist.")
    }
    throw new AppError(500, "Could not save waitlist signup.")
  }
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code?: string }).code === "23505"
}
