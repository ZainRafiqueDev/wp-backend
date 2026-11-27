import { pool } from "../lib/db.js"
import { AppError } from "../lib/errors.js"
import type { ContactInput } from "../validators/contact.validator.js"

export async function createContactSubmission(input: ContactInput) {
  if (!pool) {
    throw new AppError(503, "Database is not configured. Set DATABASE_URL and JWT_SECRET.")
  }

  try {
    await pool.query(
      "insert into contact_submissions (name, email, message) values ($1, $2, $3)",
      [input.name, input.email, input.message],
    )
  } catch {
    throw new AppError(500, "Could not save contact submission.")
  }
}
