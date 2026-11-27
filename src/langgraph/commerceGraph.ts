
import { StateGraph, START, END } from "@langchain/langgraph"

import { CommerceState, type CommerceStateType } from "./state.js"
import {
  classifyIntentNode,
  productLookupNode,
  buildOrderDraftNode,
  confirmWithCustomerNode,
  finalValidationNode,
  commitOrderNode,
  orderStatusLookupNode,
  createSupportTicketNode,
} from "./nodes.js"
import { getCommerceCheckpointer } from "./checkpointer.js"
import { identifyCustomerNode, routeAfterVerification, verifyCodeNode } from "./customerVerificationNodes.js"

// CS-04: order status (and the booking number / notifications it carries)
// needs proof that the visitor owns the email; product questions, ordering
// and support tickets stay anonymous.
function routeToOrderStatus(state: CommerceStateType): "verify_code" | "order_status_lookup" | typeof END {
  return routeAfterVerification(state, "order_status_lookup", END) as "verify_code" | "order_status_lookup" | typeof END
}

function routeFromClassify(state: CommerceStateType): string {
  switch (state.intent) {
    case "product_question":
    case "order_intent":
      
      return "product_lookup"
    case "order_status":
      return "identify_customer"
    case "support":
      return "create_support_ticket"
    default:
      return END
  }
}

function routeFromConfirm(state: CommerceStateType): string {
  return state.responseText === "confirmed" ? "final_validation" : END
}

function routeFromValidation(state: CommerceStateType): string {
  return state.validationIssue ? "confirm_with_customer" : "commit_order"
}

const graph = new StateGraph(CommerceState)
  .addNode("classify_intent", classifyIntentNode)
  .addNode("product_lookup", productLookupNode)
  .addNode("build_order_draft", buildOrderDraftNode)
  .addNode("confirm_with_customer", confirmWithCustomerNode)
  .addNode("final_validation", finalValidationNode)
  .addNode("commit_order", commitOrderNode)
  .addNode("identify_customer", identifyCustomerNode)
  .addNode("verify_code", verifyCodeNode)
  .addNode("order_status_lookup", orderStatusLookupNode)
  .addNode("create_support_ticket", createSupportTicketNode)
  .addEdge(START, "classify_intent")
  .addConditionalEdges("classify_intent", routeFromClassify, ["product_lookup", "identify_customer", "create_support_ticket", END])
  .addConditionalEdges("identify_customer", routeToOrderStatus, ["verify_code", "order_status_lookup", END])
  .addConditionalEdges("verify_code", routeToOrderStatus, ["verify_code", "order_status_lookup", END])
  .addConditionalEdges("product_lookup", (state) => (state.intent === "order_intent" ? "build_order_draft" : END), ["build_order_draft", END])
  .addEdge("build_order_draft", "confirm_with_customer")
  .addConditionalEdges("confirm_with_customer", routeFromConfirm, ["final_validation", END])
  .addConditionalEdges("final_validation", routeFromValidation, ["confirm_with_customer", "commit_order"])
  .addEdge("commit_order", END)
  .addEdge("order_status_lookup", END)
  .addEdge("create_support_ticket", END)

let compiled: ReturnType<typeof graph.compile> | null = null


export async function getCommerceGraph() {
  if (!compiled) {
    const checkpointer = await getCommerceCheckpointer()
    compiled = graph.compile({ checkpointer })
  }
  return compiled
}
