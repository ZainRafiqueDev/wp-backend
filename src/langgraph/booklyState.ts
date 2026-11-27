import { Annotation } from "@langchain/langgraph"

import { customerVerificationChannels } from "./customerVerificationNodes.js"


export interface BooklyDraft {
  startTime: string | null // ISO 8601
  duration: number
  customerName: string | null
  customerEmail: string | null
  customerPhone: string | null
  notes: string | null
  attachmentUrl: string | null
}

export interface TurnMessage {
  role: "user" | "assistant"
  content: string
}

export const BooklyState = Annotation.Root({
  chatbotId: Annotation<string>(),
  customerId: Annotation<string | null>({ reducer: (_prev, next) => next, default: () => null }),
  intent: Annotation<string | null>({ reducer: (_prev, next) => next, default: () => null }),
  
  selectedResourceId: Annotation<string | null>({ reducer: (_prev, next) => next, default: () => null }),
  selectedResourceLabel: Annotation<string | null>({ reducer: (_prev, next) => next, default: () => null }),
  
  checkedDate: Annotation<string | null>({ reducer: (_prev, next) => next, default: () => null }),
  availableSlots: Annotation<string[]>({ reducer: (_prev, next) => next, default: () => [] }),
  bookingDraft: Annotation<BooklyDraft | null>({ reducer: (_prev, next) => next, default: () => null }),
  validationIssue: Annotation<string | null>({ reducer: (_prev, next) => next, default: () => null }),
  responseText: Annotation<string | null>({ reducer: (_prev, next) => next, default: () => null }),
  committedAppointmentId: Annotation<string | null>({ reducer: (_prev, next) => next, default: () => null }),
  messages: Annotation<TurnMessage[]>({
    reducer: (prev, next) => prev.concat(next),
    default: () => [],
  }),
  // CS-04: email ownership proof (OTP or signed customer token). Only
  // verifiedCustomerId may be used to read/change an existing customer's data.
  ...customerVerificationChannels,
  requestId: Annotation<string | undefined>({ reducer: (_prev, next) => next, default: () => undefined }),
  graphRunId: Annotation<string>(),
})

export type BooklyStateType = typeof BooklyState.State
export type BooklyStateUpdate = typeof BooklyState.Update
