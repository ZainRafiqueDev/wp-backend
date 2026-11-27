import type { Request, Response } from "express"
import { describe, expect, it, vi } from "vitest"

import { errorHandler } from "../../src/middleware/errorHandler.js"
import { AppError } from "../../src/lib/errors.js"
import { baseLogger } from "../../src/lib/logger.js"

function fakeRes() {
  const res: Partial<Response> & { statusCode?: number; body?: unknown } = {}
  res.status = vi.fn((code: number) => {
    res.statusCode = code
    return res as Response
  })
  res.json = vi.fn((body: unknown) => {
    res.body = body
    return res as Response
  })
  return res as Response & { statusCode: number; body: unknown }
}

describe("errorHandler", () => {
  it("includes which ingest cap was hit on a 409 AppError", () => {
    const res = fakeRes()
    errorHandler(new AppError(409, "You've reached the 25-document limit for this chatbot. Delete an existing document first.", { cap: "documents" }), {} as Request, res, vi.fn())
    expect(res.statusCode).toBe(409)
    expect(res.body).toEqual({
      ok: false,
      error: "You've reached the 25-document limit for this chatbot. Delete an existing document first.",
      cap: "documents",
    })
  })

  it("maps a known AppError to its status and message", () => {
    const res = fakeRes()
    errorHandler(new AppError(404, "Chatbot not found"), {} as Request, res, vi.fn())
    expect(res.statusCode).toBe(404)
    expect(res.body).toEqual({ ok: false, error: "Chatbot not found" })
  })

  it("never leaks a stack trace or internal error detail for an unexpected error", () => {
    const res = fakeRes()
    const loggerSpy = vi.spyOn(baseLogger, "error").mockImplementation(() => baseLogger)

    const realError = new Error("connection to postgres at 10.0.4.12:5432 refused, password=hunter2")
    errorHandler(realError, {} as Request, res, vi.fn())

    expect(res.statusCode).toBe(500)
    expect(res.body).toEqual({ ok: false, error: "Something went wrong" })
    const responseText = JSON.stringify(res.body)
    expect(responseText).not.toContain("hunter2")
    expect(responseText).not.toContain("10.0.4.12")
    expect(responseText).not.toContain(realError.stack)

    loggerSpy.mockRestore()
  })

  it("still gives the real error to the server log (structured, via lib/logger.ts), just not the client", () => {
    const res = fakeRes()
    const loggerSpy = vi.spyOn(baseLogger, "error").mockImplementation(() => baseLogger)
    const realError = new Error("actual internal detail")

    errorHandler(realError, {} as Request, res, vi.fn())

    expect(loggerSpy).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.objectContaining({ message: "actual internal detail" }) }),
      "unhandled error",
    )
    loggerSpy.mockRestore()
  })

  it("maps a body-parser JSON error to a clean 400, not a 500", () => {
    const res = fakeRes()
    const parseError = Object.assign(new Error("Unexpected token"), { type: "entity.parse.failed" })
    errorHandler(parseError, {} as Request, res, vi.fn())
    expect(res.statusCode).toBe(400)
    expect(res.body).toEqual({ ok: false, error: "Invalid JSON" })
  })

  it("maps a body-parser payload-too-large error to a clean 413, not a 500", () => {
    const res = fakeRes()
    const tooLargeError = Object.assign(new Error("request entity too large"), { type: "entity.too.large" })
    errorHandler(tooLargeError, {} as Request, res, vi.fn())
    expect(res.statusCode).toBe(413)
    expect(res.body).toEqual({ ok: false, error: "Request body is too large." })
  })
})
