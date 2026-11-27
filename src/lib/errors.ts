export class AppError extends Error {
  readonly status: number
  readonly cap?: "documents" | "bytes" | "chunks"
  readonly code?: string
  readonly data?: Record<string, unknown>

  constructor(
    status: number,
    message: string,
    extras?: { cap?: "documents" | "bytes" | "chunks"; code?: string; data?: Record<string, unknown> },
  ) {
    super(message)
    this.name = "AppError"
    this.status = status
    this.cap = extras?.cap
    this.code = extras?.code
    this.data = extras?.data
  }
}
