import { Annotation } from "@langchain/langgraph"

import { customerVerificationChannels } from "./customerVerificationNodes.js"

import type { CatalogProduct } from "../services/productCatalog.service.js"

export interface DraftLineItem {
  wooProductId: number
  productName: string
  quantity: number
  cachedUnitPrice: number
}

export interface OrderDraft {
  lineItems: DraftLineItem[]
  customerFirstName: string | null
  customerLastName: string | null
  customerEmail: string | null
  customerPhone: string | null
}

export interface TurnMessage {
  role: "user" | "assistant"
  content: string
}


export const CommerceState = Annotation.Root({
  chatbotId: Annotation<string>(),
  customerId: Annotation<string | null>({ reducer: (_prev, next) => next, default: () => null }),
  intent: Annotation<string | null>({ reducer: (_prev, next) => next, default: () => null }),
  candidateProducts: Annotation<CatalogProduct[]>({ reducer: (_prev, next) => next, default: () => [] }),
  orderDraft: Annotation<OrderDraft | null>({ reducer: (_prev, next) => next, default: () => null }),
  validationIssue: Annotation<string | null>({ reducer: (_prev, next) => next, default: () => null }),
  responseText: Annotation<string | null>({ reducer: (_prev, next) => next, default: () => null }),
  committedOrderId: Annotation<string | null>({ reducer: (_prev, next) => next, default: () => null }),
  messages: Annotation<TurnMessage[]>({
    reducer: (prev, next) => prev.concat(next),
    default: () => [],
  }),
  // CS-04: email ownership proof (OTP or signed customer token). Only
  // verifiedCustomerId may be used to read/change an existing customer's data.
  ...customerVerificationChannels,
  // §11 observability context.
  requestId: Annotation<string | undefined>({ reducer: (_prev, next) => next, default: () => undefined }),
  graphRunId: Annotation<string>(),
})

export type CommerceStateType = typeof CommerceState.State
export type CommerceStateUpdate = typeof CommerceState.Update
