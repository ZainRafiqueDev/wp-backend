import express, { type Express } from "express"

import { availableSlotsFor, createBooking, getBooking, getService, isSlotAvailable, SERVICES } from "./store.js"

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/


function requireApiKey(apiKey: string | undefined) {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (!apiKey) return next()
    const header = req.header("authorization") || ""
    if (header === `Bearer ${apiKey}`) return next()
    res.status(401).json({ error: "Missing or invalid API key." })
  }
}

export function createApp(options: { apiKey?: string } = {}): Express {
  const app = express()
  app.use(express.json())

  app.get("/health", (_req, res) => {
    res.status(200).json({ ok: true })
  })

  const auth = requireApiKey(options.apiKey)

  app.get("/services", auth, (_req, res) => {
    res.status(200).json(SERVICES)
  })

  app.get("/availability", auth, (req, res) => {
    const serviceId = String(req.query.serviceId || "")
    const date = String(req.query.date || "")

    if (!serviceId || !getService(serviceId)) {
      res.status(400).json({ error: "Unknown or missing serviceId. See GET /services for valid ids." })
      return
    }
    if (!DATE_PATTERN.test(date)) {
      res.status(400).json({ error: "date must be in YYYY-MM-DD format." })
      return
    }

    const slots = availableSlotsFor(serviceId, date)
    res.status(200).json({ serviceId, date, availableSlots: slots ?? [] })
  })

  app.post("/bookings", auth, (req, res) => {
    const body = req.body as {
      serviceId?: unknown
      date?: unknown
      time?: unknown
      customerName?: unknown
      customerEmail?: unknown
      customerPhone?: unknown
      notes?: unknown
    }

    const serviceId = typeof body.serviceId === "string" ? body.serviceId : ""
    const date = typeof body.date === "string" ? body.date : ""
    const time = typeof body.time === "string" ? body.time : ""
    const customerName = typeof body.customerName === "string" ? body.customerName.trim() : ""
    const customerEmail = typeof body.customerEmail === "string" ? body.customerEmail.trim() : ""
    const customerPhone = typeof body.customerPhone === "string" ? body.customerPhone : null
    const notes = typeof body.notes === "string" ? body.notes : null

    if (!getService(serviceId)) {
      res.status(400).json({ error: "Unknown or missing serviceId. See GET /services for valid ids." })
      return
    }
    if (!DATE_PATTERN.test(date)) {
      res.status(400).json({ error: "date must be in YYYY-MM-DD format." })
      return
    }
    if (!TIME_PATTERN.test(time)) {
      res.status(400).json({ error: "time must be in HH:MM 24-hour format." })
      return
    }
    if (!customerName) {
      res.status(400).json({ error: "customerName is required." })
      return
    }
    if (!customerEmail || !EMAIL_PATTERN.test(customerEmail)) {
      res.status(400).json({ error: "A valid customerEmail is required." })
      return
    }
    if (!isSlotAvailable(serviceId, date, time)) {
      res.status(409).json({ error: `That slot is no longer available. Check GET /availability for open times on ${date}.` })
      return
    }

    const booking = createBooking({ serviceId, date, time, customerName, customerEmail, customerPhone, notes })
    const service = getService(serviceId)
    res.status(201).json({
      bookingId: booking.id,
      status: "confirmed",
      confirmationDetails: `${service?.name} booked for ${date} at ${time}. A confirmation has been sent to ${customerEmail}.`,
    })
  })

  app.get("/bookings/:id", auth, (req, res) => {
    const idParam = req.params.id
    const booking = getBooking(Array.isArray(idParam) ? idParam[0] : idParam)
    if (!booking) {
      res.status(404).json({ error: "No booking with that id." })
      return
    }
    res.status(200).json(booking)
  })

  return app
}
