
import { assertSafeUrl } from "../crawler/ssrf.js"
import { outboundFetch } from "../outboundFetch.js"
import { log } from "../logger.js"
import type {
  AddNoteToBooklyAppointmentInput,
  BooklyAppointment,
  BooklyCredentials,
  BooklyServiceInfo,
  CreateBooklyAppointmentInput,
  RescheduleBooklyAppointmentInput,
  WaitlistEntryInput,
} from "./types.js"

const REQUEST_TIMEOUT_MS = 8000

export class BooklyApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
    this.name = "BooklyApiError"
  }
}


export function isBooklyConflict(err: unknown): err is BooklyApiError {
  return err instanceof BooklyApiError && err.status === 409
}

async function booklyFetch<T>(creds: BooklyCredentials, path: string, init?: RequestInit): Promise<T> {
  const url = new URL(`${creds.baseUrl}${path}`)
  await assertSafeUrl(url)

  let res: Response
  try {
    res = await outboundFetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${creds.apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(init?.headers as Record<string, string> | undefined),
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (err) {
    log().warn({ err: err instanceof Error ? err.message : String(err), path }, "bookly request failed or timed out")
    throw new BooklyApiError(0, "Could not reach the Bookly server.")
  }

  const text = await res.text().catch(() => "")
  const json = text ? JSON.parse(text) : null

  if (!res.ok) {
    const message =
      json && typeof json === "object" && "error" in json && json.error && typeof json.error === "object" && "message" in json.error
        ? String((json.error as { message: unknown }).message)
        : `Bookly request failed (${res.status})`
    throw new BooklyApiError(res.status, message)
  }
  return json as T
}

export async function getAvailableSlots(creds: BooklyCredentials, date: string, duration?: number): Promise<string[]> {
  const query = duration ? `?date=${date}&duration=${duration}` : `?date=${date}`
  const result = await booklyFetch<{ available_slots: string[] }>(creds, `/resources/${creds.resourceId}/available-slots${query}`)
  return result.available_slots
}

export async function createAppointment(creds: BooklyCredentials, input: CreateBooklyAppointmentInput): Promise<BooklyAppointment> {
  return booklyFetch<BooklyAppointment>(creds, "/appointments", {
    method: "POST",
    body: JSON.stringify({
      resource_id: input.resourceId,
      start_time: input.startTime,
      duration: input.duration,
      customer_name: input.customer.name,
      customer_email: input.customer.email,
      customer_phone: input.customer.phone ?? null,
      notes: input.notes ?? null,
      attachment_url: input.attachmentUrl ?? null,
    }),
  })
}

export async function getAppointment(creds: BooklyCredentials, appointmentId: string): Promise<BooklyAppointment> {
  return booklyFetch<BooklyAppointment>(creds, `/appointments/${appointmentId}`)
}

export async function cancelAppointment(creds: BooklyCredentials, appointmentId: string): Promise<BooklyAppointment> {
  return booklyFetch<BooklyAppointment>(creds, `/appointments/${appointmentId}/cancel`, { method: "POST" })
}

export async function addNote(
  creds: BooklyCredentials,
  appointmentId: string,
  input: AddNoteToBooklyAppointmentInput,
): Promise<BooklyAppointment> {
  return booklyFetch<BooklyAppointment>(creds, `/appointments/${appointmentId}/notes`, {
    method: "POST",
    body: JSON.stringify({
      ...(input.note ? { note: input.note } : {}),
      ...(input.attachmentUrl ? { attachment_url: input.attachmentUrl } : {}),
    }),
  })
}

export async function rescheduleAppointment(
  creds: BooklyCredentials,
  appointmentId: string,
  input: RescheduleBooklyAppointmentInput,
): Promise<BooklyAppointment> {
  return booklyFetch<BooklyAppointment>(creds, `/appointments/${appointmentId}/reschedule`, {
    method: "POST",
    body: JSON.stringify({
      start_time: input.startTime,
      duration: input.duration,
      ...(input.resourceId ? { resource_id: input.resourceId } : {}),
    }),
  })
}


export async function getServiceInfo(creds: BooklyCredentials): Promise<BooklyServiceInfo> {
  return booklyFetch<BooklyServiceInfo>(creds, `/resources/${creds.resourceId}/service-info`)
}


export async function joinWaitlist(creds: BooklyCredentials, input: WaitlistEntryInput): Promise<{ id: string }> {
  return booklyFetch<{ id: string }>(creds, "/appointments/waitlist", {
    method: "POST",
    body: JSON.stringify({
      resource_id: input.resourceId,
      customer_name: input.customerName,
      customer_email: input.customerEmail,
      requested_date: input.requestedDate,
    }),
  })
}


export async function getMeetingHistoryReportPdf(creds: BooklyCredentials, params: { from?: string; to?: string } = {}): Promise<Buffer> {
  const query = new URLSearchParams()
  if (params.from) query.set("from", params.from)
  if (params.to) query.set("to", params.to)
  const qs = query.toString()
  const url = new URL(`${creds.baseUrl}/reports/meeting-history${qs ? `?${qs}` : ""}`)
  await assertSafeUrl(url)

  let res: Response
  try {
    res = await outboundFetch(url, {
      headers: { Authorization: `Bearer ${creds.apiKey}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (err) {
    log().warn({ err: err instanceof Error ? err.message : String(err) }, "bookly meeting-history report request failed or timed out")
    throw new BooklyApiError(0, "Could not reach the Bookly server.")
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "")
    let message = `Bookly request failed (${res.status})`
    try {
      const json = text ? JSON.parse(text) : null
      if (json && typeof json === "object" && "error" in json && json.error && typeof json.error === "object" && "message" in json.error) {
        message = String((json.error as { message: unknown }).message)
      }
    } catch {
      
    }
    throw new BooklyApiError(res.status, message)
  }

  return Buffer.from(await res.arrayBuffer())
}
