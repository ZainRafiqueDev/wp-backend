
import { assertSafeUrl } from "../crawler/ssrf.js"
import { outboundFetch } from "../outboundFetch.js"
import { log } from "../logger.js"

const REQUEST_TIMEOUT_MS = 8000

export class BooklyAdminApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
    this.name = "BooklyAdminApiError"
  }
}

export interface BooklyAdminIdentity {
  id: string
  name: string
  email: string
  role: "ADMIN" | "STAFF"
  is_active: boolean
}

export interface CreateResourceInput {
  name: string
  timezone?: string
  slot_duration_minutes?: number
}

export interface CreateAvailabilityRuleInput {
  day_of_week: number
  start_time: string
  end_time: string
  break_start?: string | null
  break_end?: string | null
}

export interface CreateExceptionInput {
  date: string
  is_closed?: boolean
  reason?: string | null
}

export interface BooklyResource {
  id: string
  name: string
  timezone: string
  slot_duration_minutes: number
}

export interface ReassignAppointmentInput {
  startTime: string
  duration: number
  resourceId: string
}

export interface BooklyAdminAppointment {
  id: string
  resource_id: string
  customer_name: string
  customer_email: string
  start_time: string
  end_time: string
  status: "CONFIRMED" | "CANCELLED"
}

async function booklyAdminFetch<T>(baseUrl: string, token: string, path: string, init?: RequestInit): Promise<T> {
  const url = new URL(`${baseUrl}${path}`)
  await assertSafeUrl(url)

  let res: Response
  try {
    res = await outboundFetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(init?.headers as Record<string, string> | undefined),
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (err) {
    log().warn({ err: err instanceof Error ? err.message : String(err), path }, "bookly admin request failed or timed out")
    throw new BooklyAdminApiError(0, "Could not reach the Bookly server.")
  }

  const text = await res.text().catch(() => "")
  const json = text ? JSON.parse(text) : null

  if (!res.ok) {
    const message =
      json && typeof json === "object" && "error" in json && json.error && typeof json.error === "object" && "message" in json.error
        ? String((json.error as { message: unknown }).message)
        : `Bookly admin request failed (${res.status})`
    throw new BooklyAdminApiError(res.status, message)
  }
  return json as T
}


export async function verifyAdminSession(baseUrl: string, token: string): Promise<BooklyAdminIdentity | null> {
  try {
    return await booklyAdminFetch<BooklyAdminIdentity>(baseUrl, token, "/auth/me")
  } catch (err) {
    if (err instanceof BooklyAdminApiError && (err.status === 401 || err.status === 403)) return null
    throw err
  }
}

export async function createResource(baseUrl: string, token: string, input: CreateResourceInput): Promise<BooklyResource> {
  return booklyAdminFetch<BooklyResource>(baseUrl, token, "/resources", { method: "POST", body: JSON.stringify(input) })
}

export async function createAvailabilityRule(baseUrl: string, token: string, resourceId: string, input: CreateAvailabilityRuleInput): Promise<unknown> {
  return booklyAdminFetch(baseUrl, token, `/resources/${resourceId}/availability-rules`, { method: "POST", body: JSON.stringify(input) })
}

export async function createException(baseUrl: string, token: string, resourceId: string, input: CreateExceptionInput): Promise<unknown> {
  return booklyAdminFetch(baseUrl, token, `/resources/${resourceId}/exceptions`, { method: "POST", body: JSON.stringify(input) })
}

export async function getAppointment(baseUrl: string, token: string, appointmentId: string): Promise<BooklyAdminAppointment> {
  return booklyAdminFetch<BooklyAdminAppointment>(baseUrl, token, `/appointments/${appointmentId}`)
}


export async function reassignAppointment(baseUrl: string, token: string, appointmentId: string, input: ReassignAppointmentInput): Promise<BooklyAdminAppointment> {
  return booklyAdminFetch<BooklyAdminAppointment>(baseUrl, token, `/appointments/${appointmentId}/reschedule`, {
    method: "POST",
    body: JSON.stringify({ start_time: input.startTime, duration: input.duration, resource_id: input.resourceId }),
  })
}
