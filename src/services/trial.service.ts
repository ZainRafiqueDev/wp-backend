import { pool } from "../lib/db.js"
import { AppError } from "../lib/errors.js"
import type { TrialInput } from "../validators/trial.validator.js"

export async function createTrialSignup(input: TrialInput) {
  if (!pool) {
    throw new AppError(503, "Database is not configured. Set DATABASE_URL and JWT_SECRET.")
  }

  try {
    await pool.query(
      "insert into trial_signups (name, email, company, plan) values ($1, $2, $3, $4)",
      [input.name, input.email, input.company || null, input.plan || null],
    )
  } catch {
    throw new AppError(500, "Could not save trial signup.")
  }
}
