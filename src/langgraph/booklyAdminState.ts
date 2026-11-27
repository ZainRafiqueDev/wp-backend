import { Annotation } from "@langchain/langgraph"


export type AdminAction = "create_resource" | "set_availability_rule" | "add_exception" | "reassign_appointment"

export interface AdminActionDraft {
  action: AdminAction
  
  params: Record<string, unknown>
}

export interface TurnMessage {
  role: "user" | "assistant"
  content: string
}

export const BooklyAdminState = Annotation.Root({
  chatbotId: Annotation<string>(),
  
  adminId: Annotation<string>(),
  adminEmail: Annotation<string>(),
  intent: Annotation<AdminAction | "other" | null>({ reducer: (_prev, next) => next, default: () => null }),
  draft: Annotation<AdminActionDraft | null>({ reducer: (_prev, next) => next, default: () => null }),
  responseText: Annotation<string | null>({ reducer: (_prev, next) => next, default: () => null }),
  executedTargetId: Annotation<string | null>({ reducer: (_prev, next) => next, default: () => null }),
  messages: Annotation<TurnMessage[]>({
    reducer: (prev, next) => prev.concat(next),
    default: () => [],
  }),
  requestId: Annotation<string | undefined>({ reducer: (_prev, next) => next, default: () => undefined }),
  graphRunId: Annotation<string>(),
})

export type BooklyAdminStateType = typeof BooklyAdminState.State
