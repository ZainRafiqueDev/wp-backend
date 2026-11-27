import { beforeEach, describe, expect, it } from "vitest"
import request from "supertest"

import { createApp } from "../src/app.js"
import { resetBookingsForTests } from "../src/store.js"

describe("booking-api demo", () => {
  beforeEach(() => {
    resetBookingsForTests()
  })

  it("GET /health reports ok without requiring an API key", async () => {
    const app = createApp({ apiKey: "secret" })
    const res = await request(app).get("/health")
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
  })

  it("lists services", async () => {
    const app = createApp()
    const res = await request(app).get("/services")
    expect(res.status).toBe(200)
    expect(res.body.some((s: { id: string }) => s.id === "consult-30")).toBe(true)
  })

  it("rejects requests missing the configured API key", async () => {
    const app = createApp({ apiKey: "secret" })
    const res = await request(app).get("/services")
    expect(res.status).toBe(401)
  })

  it("accepts requests carrying the configured API key", async () => {
    const app = createApp({ apiKey: "secret" })
    const res = await request(app).get("/services").set("Authorization", "Bearer secret")
    expect(res.status).toBe(200)
  })

  it("returns available slots for a service and date", async () => {
    const app = createApp()
    const res = await request(app).get("/availability").query({ serviceId: "consult-30", date: "2026-10-05" })
    expect(res.status).toBe(200)
    expect(res.body.availableSlots).toContain("09:00")
    expect(res.body.availableSlots.length).toBeGreaterThan(0)
  })

  it("400s availability for an unknown service", async () => {
    const app = createApp()
    const res = await request(app).get("/availability").query({ serviceId: "nope", date: "2026-10-05" })
    expect(res.status).toBe(400)
  })

  it("creates a booking for an open slot and confirms it", async () => {
    const app = createApp()
    const res = await request(app).post("/bookings").send({
      serviceId: "consult-30",
      date: "2026-10-05",
      time: "09:00",
      customerName: "Ada Lovelace",
      customerEmail: "ada@example.com",
    })
    expect(res.status).toBe(201)
    expect(res.body.status).toBe("confirmed")
    expect(res.body.bookingId).toBeTruthy()

    const fetched = await request(app).get(`/bookings/${res.body.bookingId}`)
    expect(fetched.status).toBe(200)
    expect(fetched.body.customerEmail).toBe("ada@example.com")
  })

  it("removes a booked slot from availability, and rejects double-booking the same slot", async () => {
    const app = createApp()
    await request(app).post("/bookings").send({
      serviceId: "consult-30",
      date: "2026-10-05",
      time: "09:00",
      customerName: "Ada Lovelace",
      customerEmail: "ada@example.com",
    })

    const availability = await request(app).get("/availability").query({ serviceId: "consult-30", date: "2026-10-05" })
    expect(availability.body.availableSlots).not.toContain("09:00")

    const conflict = await request(app).post("/bookings").send({
      serviceId: "consult-30",
      date: "2026-10-05",
      time: "09:00",
      customerName: "Grace Hopper",
      customerEmail: "grace@example.com",
    })
    expect(conflict.status).toBe(409)
  })

  it("400s a booking with an invalid email", async () => {
    const app = createApp()
    const res = await request(app).post("/bookings").send({
      serviceId: "consult-30",
      date: "2026-10-05",
      time: "09:00",
      customerName: "Ada Lovelace",
      customerEmail: "not-an-email",
    })
    expect(res.status).toBe(400)
  })
})
