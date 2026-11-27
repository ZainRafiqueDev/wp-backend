
import { StateGraph, START, END } from "@langchain/langgraph"

import { BooklyAdminState, type BooklyAdminStateType } from "./booklyAdminState.js"
import { classifyAdminIntentNode, buildActionDraftNode, confirmAdminActionNode, executeAdminActionNode } from "./booklyAdminNodes.js"
import { getCommerceCheckpointer } from "./checkpointer.js"

function routeFromClassify(state: BooklyAdminStateType): string {
  return state.intent && state.intent !== "other" ? "build_action_draft" : END
}

function routeFromConfirm(state: BooklyAdminStateType): string {
  return state.responseText === "confirmed" ? "execute_admin_action" : END
}

const graph = new StateGraph(BooklyAdminState)
  .addNode("classify_admin_intent", classifyAdminIntentNode)
  .addNode("build_action_draft", buildActionDraftNode)
  .addNode("confirm_admin_action", confirmAdminActionNode)
  .addNode("execute_admin_action", executeAdminActionNode)
  .addEdge(START, "classify_admin_intent")
  .addConditionalEdges("classify_admin_intent", routeFromClassify, ["build_action_draft", END])
  .addEdge("build_action_draft", "confirm_admin_action")
  .addConditionalEdges("confirm_admin_action", routeFromConfirm, ["execute_admin_action", END])
  .addEdge("execute_admin_action", END)

let compiled: ReturnType<typeof graph.compile> | null = null

export async function getBooklyAdminGraph() {
  if (!compiled) {
    const checkpointer = await getCommerceCheckpointer()
    compiled = graph.compile({ checkpointer })
  }
  return compiled
}
