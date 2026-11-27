
import { StateGraph, START, END } from "@langchain/langgraph"

import { BooklyState, type BooklyStateType } from "./booklyState.js"
import {
  classifyIntentNode,
  selectResourceNode,
  checkAvailabilityNode,
  buildBookingDraftNode,
  confirmWithCustomerNode,
  finalValidationNode,
  commitBookingNode,
  appointmentStatusLookupNode,
  addNoteNode,
  rescheduleAppointmentNode,
  cancelAppointmentNode,
  pricingQuestionNode,
  offerWaitlistNode,
} from "./booklyNodes.js"
import { getCommerceCheckpointer } from "./checkpointer.js"
import { identifyCustomerNode, routeAfterVerification, verifyCodeNode } from "./customerVerificationNodes.js"

// CS-04: intents that touch an EXISTING booking and so need proof that the
// visitor owns the email it is under. Availability, pricing and new bookings
// stay anonymous.
const VERIFIED_INTENT_NODES = {
  appointment_status: "appointment_status_lookup",
  add_note: "add_note",
  reschedule_appointment: "reschedule_appointment",
  cancel_appointment: "cancel_appointment",
} as const
type VerifiedOperationNode = (typeof VERIFIED_INTENT_NODES)[keyof typeof VERIFIED_INTENT_NODES]
const VERIFIED_ROUTES = ["verify_code", "appointment_status_lookup", "add_note", "reschedule_appointment", "cancel_appointment", END] as const

function routeToVerifiedOperation(state: BooklyStateType): string {
  const target: VerifiedOperationNode | undefined = state.intent ? VERIFIED_INTENT_NODES[state.intent as keyof typeof VERIFIED_INTENT_NODES] : undefined
  if (!target) return END
  return routeAfterVerification(state, target, END)
}

function routeFromClassify(state: BooklyStateType): string {
  switch (state.intent) {
    case "availability_question":
    case "booking_intent":
      return "select_resource"
    case "appointment_status":
    case "add_note":
    case "reschedule_appointment":
    case "cancel_appointment":
      return "identify_customer"
    case "pricing_question":
      return "pricing_question"
    default:
      return END
  }
}

function routeFromConfirm(state: BooklyStateType): string {
  return state.responseText === "confirmed" ? "final_validation" : END
}

function routeFromValidation(state: BooklyStateType): string {
  return state.validationIssue ? "build_booking_draft" : "commit_booking"
}

const graph = new StateGraph(BooklyState)
  .addNode("classify_intent", classifyIntentNode)
  .addNode("select_resource", selectResourceNode)
  .addNode("check_availability", checkAvailabilityNode)
  .addNode("build_booking_draft", buildBookingDraftNode)
  .addNode("confirm_with_customer", confirmWithCustomerNode)
  .addNode("final_validation", finalValidationNode)
  .addNode("commit_booking", commitBookingNode)
  .addNode("identify_customer", identifyCustomerNode)
  .addNode("verify_code", verifyCodeNode)
  .addNode("appointment_status_lookup", appointmentStatusLookupNode)
  .addNode("add_note", addNoteNode)
  .addNode("reschedule_appointment", rescheduleAppointmentNode)
  .addNode("cancel_appointment", cancelAppointmentNode)
  .addNode("pricing_question", pricingQuestionNode)
  .addNode("offer_waitlist", offerWaitlistNode)
  .addEdge(START, "classify_intent")
  .addConditionalEdges("classify_intent", routeFromClassify, [
    "select_resource",
    "identify_customer",
    "pricing_question",
    END,
  ])
  .addConditionalEdges("identify_customer", routeToVerifiedOperation, [...VERIFIED_ROUTES])
  .addConditionalEdges("verify_code", routeToVerifiedOperation, [...VERIFIED_ROUTES])
  
  .addEdge("select_resource", "check_availability")
 
  .addConditionalEdges(
    "check_availability",
    (state) => {
      if (state.intent !== "booking_intent" || state.responseText) return END
      
      if (state.availableSlots.length === 0) return "offer_waitlist"
      return "build_booking_draft"
    },
    ["build_booking_draft", "offer_waitlist", END],
  )
  .addEdge("build_booking_draft", "confirm_with_customer")
  .addConditionalEdges("confirm_with_customer", routeFromConfirm, ["final_validation", END])
  .addConditionalEdges("final_validation", routeFromValidation, ["build_booking_draft", "commit_booking"])
  .addEdge("commit_booking", END)
  .addEdge("appointment_status_lookup", END)
  .addEdge("add_note", END)
  .addEdge("reschedule_appointment", END)
  .addEdge("cancel_appointment", END)
  .addEdge("pricing_question", END)
  .addEdge("offer_waitlist", END)

let compiled: ReturnType<typeof graph.compile> | null = null


export async function getBooklyGraph() {
  if (!compiled) {
    const checkpointer = await getCommerceCheckpointer()
    compiled = graph.compile({ checkpointer })
  }
  return compiled
}
