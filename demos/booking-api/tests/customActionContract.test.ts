// Proves that the exact Custom Action definitions documented in README.md
// (the ones a chatbot owner would POST to
// /chatbots/:chatbotId/actions on their real ChatMate360 account) produce
// requests this API actually accepts — i.e. the contract documented for the
// AI to call and the real route handlers agree. This mirrors, by hand, the
// same {{param}} template-filling ChatMate360's real
// src/lib/actionExecutor.ts does (fillTemplate/fillBody) — that engine
// itself already has its own unit coverage in the main repo
// (tests/unit/actionExecutor.test.ts); what's being verified here is the
// booking API's contract, not the templating engine.
import { beforeEach, describe, expect, it } from "vitest"
import request from "supertest"

import { createApp } from "../src/app.js"
import { resetBookingsForTests } from "../src/store.js"
import { CHECK_AVAILABILITY_ACTION, CREATE_BOOKING_ACTION } from "../custom-actions.js"

function fillTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g, (match, key: string) =>
    values[key] === undefined ? match : values[key],
  )
}

describe("Custom Action definitions match the real API contract", () => {
  beforeEach(() => {
    resetBookingsForTests()
  })

  it("check_availability's urlTemplate resolves to a real, working GET request", async () => {
    const app = createApp()
    const values = { service_id: "consult-30", date: "2026-10-05" }

    expect(CHECK_AVAILABILITY_ACTION.httpMethod).toBe("GET")
    const url = new URL(fillTemplate(`https://example.invalid${CHECK_AVAILABILITY_ACTION.urlTemplate}`, values))

    const res = await request(app).get(url.pathname + url.search)
    expect(res.status).toBe(200)
    expect(res.body.availableSlots).toContain("09:00")
  })

  it("create_booking's bodyTemplate resolves to a real, working POST request", async () => {
    const app = createApp()
    const values = {
      service_id: "consult-30",
      date: "2026-10-05",
      time: "09:00",
      customer_name: "Ada Lovelace",
      customer_email: "ada@example.com",
    }

    expect(CREATE_BOOKING_ACTION.httpMethod).toBe("POST")
    const url = new URL(`https://example.invalid${CREATE_BOOKING_ACTION.urlTemplate}`)
    const body = JSON.parse(fillTemplate(JSON.stringify(CREATE_BOOKING_ACTION.bodyTemplate), values))

    const res = await request(app).post(url.pathname).send(body)
    expect(res.status).toBe(201)
    expect(res.body.status).toBe("confirmed")
  })

  it("every {{placeholder}} in create_booking's templates has a matching declared parameter", () => {
    const declared = new Set(CREATE_BOOKING_ACTION.parameters.map((p) => p.name))
    const placeholders = new Set(
      Array.from(JSON.stringify(CREATE_BOOKING_ACTION.bodyTemplate).matchAll(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g)).map(
        (m) => m[1],
      ),
    )
    for (const name of placeholders) {
      expect(declared.has(name)).toBe(true)
    }
  })
})
