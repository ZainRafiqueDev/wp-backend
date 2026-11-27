

export interface Service {
  id: string
  name: string
  durationMinutes: number
}

export interface Booking {
  id: string
  serviceId: string
  date: string 
  time: string 
  customerName: string
  customerEmail: string
  customerPhone: string | null
  notes: string | null
  createdAt: string
}

export const SERVICES: Service[] = [
  { id: "consult-30", name: "30-minute consultation", durationMinutes: 30 },
  { id: "haircut-45", name: "Haircut", durationMinutes: 45 },
  { id: "deep-clean-60", name: "Deep cleaning appointment", durationMinutes: 60 },
]

const OPEN_HOUR = 9 
const CLOSE_HOUR = 17 

const bookings = new Map<string, Booking>()
let nextId = 1

export function getService(serviceId: string): Service | undefined {
  return SERVICES.find((s) => s.id === serviceId)
}

function pad(n: number): string {
  return String(n).padStart(2, "0")
}


function allSlotsFor(service: Service): string[] {
  const slots: string[] = []
  const totalOpenMinutes = (CLOSE_HOUR - OPEN_HOUR) * 60
  for (let offset = 0; offset + service.durationMinutes <= totalOpenMinutes; offset += service.durationMinutes) {
    const minutes = OPEN_HOUR * 60 + offset
    slots.push(`${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`)
  }
  return slots
}

export function availableSlotsFor(serviceId: string, date: string): string[] | null {
  const service = getService(serviceId)
  if (!service) return null

  const taken = new Set(
    Array.from(bookings.values())
      .filter((b) => b.serviceId === serviceId && b.date === date)
      .map((b) => b.time),
  )
  return allSlotsFor(service).filter((slot) => !taken.has(slot))
}

export function isSlotAvailable(serviceId: string, date: string, time: string): boolean {
  const slots = availableSlotsFor(serviceId, date)
  return slots !== null && slots.includes(time)
}

export function createBooking(input: {
  serviceId: string
  date: string
  time: string
  customerName: string
  customerEmail: string
  customerPhone?: string | null
  notes?: string | null
}): Booking {
  const booking: Booking = {
    id: `bk_${nextId++}`,
    serviceId: input.serviceId,
    date: input.date,
    time: input.time,
    customerName: input.customerName,
    customerEmail: input.customerEmail,
    customerPhone: input.customerPhone ?? null,
    notes: input.notes ?? null,
    createdAt: new Date().toISOString(),
  }
  bookings.set(booking.id, booking)
  return booking
}

export function getBooking(id: string): Booking | undefined {
  return bookings.get(id)
}


export function resetBookingsForTests(): void {
  bookings.clear()
  nextId = 1
}
