

export interface BooklyCredentials {
  baseUrl: string 
  apiKey: string
  resourceId: string
}

export interface BooklyAppointment {
  id: string
  resource_id: string
  customer_name: string
  customer_email: string
  customer_phone: string | null
  start_time: string
  end_time: string
  status: "CONFIRMED" | "CANCELLED"
  notes: string | null

  attachment_url: string | null
  zoom_join_url: string | null
  google_meet_url: string | null
}

export interface CreateBooklyAppointmentInput {
  resourceId: string
  startTime: string
  duration: number
  customer: { name: string; email: string; phone?: string | null }
  notes?: string | null
  attachmentUrl?: string | null
}

export interface RescheduleBooklyAppointmentInput {
  startTime: string
  duration: number
  
  resourceId?: string
}


export interface AddNoteToBooklyAppointmentInput {
  note?: string | null
  attachmentUrl?: string | null
}


export interface BooklyServiceInfo {
  name: string
  price_cents: number | null
  price_currency: string
  service_description: string | null
}


export interface WaitlistEntryInput {
  resourceId: string
  customerName: string
  customerEmail: string
  requestedDate: string 
}
