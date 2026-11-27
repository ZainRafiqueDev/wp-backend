
import { interrupt } from "@langchain/langgraph"
import { HumanMessage } from "@langchain/core/messages"

import { log } from "../lib/logger.js"
import { AppError } from "../lib/errors.js"
import { pool } from "../lib/db.js"
import { getDecryptedWooCommerceCredentials } from "../services/commerceCredentials.service.js"
import { resolveCustomerIdentity } from "../services/customerIdentity.service.js"
import { lookupProducts, getLiveProductSnapshot, type CatalogProduct } from "../services/productCatalog.service.js"
import { commitOrder, type OrderSnapshot } from "../services/commerceOrder.service.js"
import { transitionOrderState, getCommerceOrder } from "../services/orderState.service.js"
import { createTicket } from "../services/commerceTicket.service.js"
import { authorizeToolCall } from "../services/toolAuthorization.service.js"
import { hasCommerceLlm } from "./llm.js"
import { invokeBilledCommerceLlm, LLM_BUDGET_DENIED_TEXT, withLlmBudget } from "./billedLlm.js"
import { CODE_FAILED_TEXT, verifiedCustomerIdFor } from "./customerVerificationNodes.js"
import type { CommerceStateType, DraftLineItem, OrderDraft } from "./state.js"

function ctx(state: CommerceStateType) {
  return { requestId: state.requestId, graphRunId: state.graphRunId, chatbotId: state.chatbotId, customerId: state.customerId }
}

const INTENTS = ["product_question", "order_intent", "order_status", "support", "other"] as const
type Intent = (typeof INTENTS)[number]


async function classifyIntentNodeImpl(state: CommerceStateType): Promise<Partial<CommerceStateType>> {
  const latest = state.messages[state.messages.length - 1]?.content ?? ""
  
  const transcript = state.messages.slice(-6).map((m) => `${m.role}: ${m.content}`).join("\n")

  if (!hasCommerceLlm()) {
    log().error(ctx(state), "classify_intent: no commerce LLM configured")
    return { intent: "other", responseText: "Sorry, ordering isn't available right now — this store's assistant isn't fully configured. Please contact the store directly." }
  }

  const result = await invokeBilledCommerceLlm(state.chatbotId, [
    new HumanMessage(
      `Classify the customer's LATEST message into exactly one category: product_question, order_intent, order_status, support, or other. Use the conversation so far only to resolve context a bare message like "yes" or "that one" can't be classified from on its own.\n\n` +
        `- product_question: asking about a product, price, or general availability, not trying to buy right now\n` +
        `- order_intent: wants to buy/order something (including a short continuation like "yes" that's clearly agreeing to an order already being discussed)\n` +
        `- order_status: asking about an existing order, payment, or booking number\n` +
        `- support: a problem, complaint, or question unrelated to placing an order\n` +
        `- other: anything else (greetings, unrelated chit-chat)\n\n` +
        `Conversation so far:\n${transcript}\n\n` +
        `Latest message: "${latest}"\n\nRespond with ONLY the single category word, nothing else.`,
    ),
  ])
  const raw = String(result.content).trim().toLowerCase()
  const intent: Intent = (INTENTS as readonly string[]).includes(raw) ? (raw as Intent) : "other"

  log().info({ ...ctx(state), intent }, "classify_intent")
  return { intent }
}
// NEW-01: a denied usage reservation ends the turn politely (see billedLlm.ts).
export const classifyIntentNode = withLlmBudget(classifyIntentNodeImpl, (): Partial<CommerceStateType> => ({ intent: "other", responseText: LLM_BUDGET_DENIED_TEXT }))


function formatProductContext(products: CatalogProduct[]): string {
  if (products.length === 0) return "(no matching products found)"
  return products
    .map((p) => {
      const price = p.price !== null ? `$${p.price}` : "no listed price"
      const stock = p.stockQuantity !== null ? `${p.stockQuantity} in stock` : "stock level not tracked"
      return `- ${p.name}: ${price}, ${stock}${p.description ? `\n  Description: ${p.description}` : ""}`
    })
    .join("\n")
}


function recentTranscript(state: CommerceStateType): string {
  return state.messages
    .slice(-6)
    .map((m) => `${m.role}: ${m.content}`)
    .join("\n")
}


function isCloseNameMatch(candidate: string, topName: string): boolean {
  return candidate.length >= topName.length * 0.6 && (topName.includes(candidate) || candidate.includes(topName))
}

export function narrowToNamedProduct(products: CatalogProduct[], latestMessage: string): CatalogProduct[] {
  if (products.length === 0) return products
  const normalizedMessage = latestMessage.trim().toLowerCase()
  const topName = products[0].name.trim().toLowerCase().replace(/\.$/, "")

 
  if (normalizedMessage.includes(topName)) return [products[0]]

  const afterColon = normalizedMessage.includes(":") ? normalizedMessage.split(":").pop()!.trim() : null
  if (afterColon && isCloseNameMatch(afterColon, topName)) return [products[0]]


  const stripped = normalizedMessage.replace(/^(show me|what is|what's|does|do you have)[:\s]*/, "").trim()
  if (isCloseNameMatch(stripped, topName)) return [products[0]]

  return products
}

async function productLookupNodeImpl(state: CommerceStateType): Promise<Partial<CommerceStateType>> {
  const transcript = recentTranscript(state)
  const latestMessage = state.messages[state.messages.length - 1]?.content ?? ""
 
  const searched = await lookupProducts(state.chatbotId, state.customerId, transcript, 5)
  const products = narrowToNamedProduct(searched, latestMessage)

  if (state.intent === "product_question") {
    if (!hasCommerceLlm()) {
      return { candidateProducts: products, responseText: "Sorry, product Q&A isn't available right now — this store's assistant isn't fully configured." }
    }
    const result = await invokeBilledCommerceLlm(state.chatbotId, [
      new HumanMessage(
        `You are a shopping assistant for an online store. Answer the customer's LATEST message using ONLY the product data below and the conversation so far for context (e.g. resolving "it"/"that one" to whichever product was just discussed) — never invent a detail (color, size, material, capacity, etc.) that isn't actually present in the name/description/price/stock given. If the data doesn't contain what they're asking (e.g. they ask about colors and none are listed), say so plainly rather than guessing. Keep it short and conversational.\n\n` +
          `Product data:\n${formatProductContext(products)}\n\n` +
          `Conversation so far:\n${transcript}\n\n` +
          `Answer the customer's latest message above.`,
      ),
    ])
    const responseText = String(result.content).trim()
    log().info({ ...ctx(state), productCount: products.length }, "product_question answered from real catalog data via LLM synthesis, grounded in conversation history")
    return { candidateProducts: products, responseText }
  }
  return { candidateProducts: products }
}
// NEW-01: a denied usage reservation ends the turn politely (see billedLlm.ts).
export const productLookupNode = withLlmBudget(productLookupNodeImpl, (): Partial<CommerceStateType> => ({ candidateProducts: [], responseText: LLM_BUDGET_DENIED_TEXT }))

interface DraftExtraction {
  productIndex: number | null
  quantity: number | null
  firstName: string | null
  lastName: string | null
  email: string | null
  phone: string | null
}

async function extractDraftFields(state: CommerceStateType): Promise<DraftExtraction> {
  const productList = state.candidateProducts.map((p, i) => `${i}: ${p.name} ($${p.price ?? "?"})`).join("\n")
  const transcript = state.messages.map((m) => `${m.role}: ${m.content}`).join("\n")

  const result = await invokeBilledCommerceLlm(state.chatbotId, [
    new HumanMessage(
      `From this conversation, extract what's known so far about an order the customer wants to place.\n\n` +
        `Candidate products (index: name (price)):\n${productList || "(none found yet)"}\n\n` +
        `Conversation:\n${transcript}\n\n` +
        `Respond with ONLY a JSON object, no other text, with these exact keys:\n` +
        `{"productIndex": <number matching the candidate list above, or null>, "quantity": <number or null>, "firstName": <string or null>, "lastName": <string or null>, "email": <string or null>, "phone": <string or null>}`,
    ),
  ])

  try {
    const parsed = JSON.parse(String(result.content).trim().replace(/^```json\s*|```$/g, ""))
    return {
      productIndex: typeof parsed.productIndex === "number" ? parsed.productIndex : null,
      quantity: typeof parsed.quantity === "number" && parsed.quantity > 0 ? parsed.quantity : null,
      firstName: typeof parsed.firstName === "string" ? parsed.firstName : null,
      lastName: typeof parsed.lastName === "string" ? parsed.lastName : null,
      email: typeof parsed.email === "string" ? parsed.email : null,
      phone: typeof parsed.phone === "string" ? parsed.phone : null,
    }
  } catch {
    return { productIndex: null, quantity: null, firstName: null, lastName: null, email: null, phone: null }
  }
}


async function buildOrderDraftNodeImpl(state: CommerceStateType): Promise<Partial<CommerceStateType>> {
  let extraction = await extractDraftFields(state)
  const localMessages: CommerceStateType["messages"] = []

  while (true) {
    const missing: string[] = []
    if (extraction.productIndex === null || !state.candidateProducts[extraction.productIndex]) missing.push("which product")
    if (!extraction.quantity) missing.push("how many")
    if (!extraction.email) missing.push("an email address to send the order confirmation to")
    if (!extraction.firstName) missing.push("a name for the order")

    if (missing.length === 0) break

    const question = `Could you tell me ${missing.join(" and ")}?`
    const reply = interrupt<string, string>(question)
    localMessages.push({ role: "assistant", content: question }, { role: "user", content: reply })
    extraction = await extractDraftFields({ ...state, messages: [...state.messages, ...localMessages] })
  }

  const product = state.candidateProducts[extraction.productIndex as number]
  const lineItem: DraftLineItem = {
    wooProductId: Number(product.woocommerceProductId),
    productName: product.name,
    quantity: extraction.quantity as number,
    cachedUnitPrice: product.price ?? 0,
  }
  const draft: OrderDraft = {
    lineItems: [lineItem],
    customerFirstName: extraction.firstName,
    customerLastName: extraction.lastName,
    customerEmail: extraction.email,
    customerPhone: extraction.phone,
  }

  log().info({ ...ctx(state), product: product.name, quantity: lineItem.quantity }, "build_order_draft complete")
  return { orderDraft: draft, messages: localMessages }
}
// NEW-01: a denied usage reservation ends the turn politely (see billedLlm.ts).
export const buildOrderDraftNode = withLlmBudget(buildOrderDraftNodeImpl, (): Partial<CommerceStateType> => ({ orderDraft: null, responseText: LLM_BUDGET_DENIED_TEXT }))

function formatDraftSummary(draft: OrderDraft): string {
  const lines = draft.lineItems.map((li) => `- ${li.quantity} x ${li.productName} @ $${li.cachedUnitPrice.toFixed(2)} = $${(li.quantity * li.cachedUnitPrice).toFixed(2)}`)
  const total = draft.lineItems.reduce((sum, li) => sum + li.quantity * li.cachedUnitPrice, 0)
  return `Here's your order:\n${lines.join("\n")}\nTotal: $${total.toFixed(2)}\n\nShall I go ahead and place this order? (yes/no)`
}


async function confirmWithCustomerNodeImpl(state: CommerceStateType): Promise<Partial<CommerceStateType>> {
  // NEW-01: build_order_draft stopped on a denied usage reservation (it clears
  // the draft and sets the reply); end the turn with that reply.
  if (!state.orderDraft) return {}
  const draft = state.orderDraft as OrderDraft
  const localMessages: CommerceStateType["messages"] = []
  const summaryPrompt = state.validationIssue ? `${state.validationIssue}\n\n${formatDraftSummary(draft)}` : formatDraftSummary(draft)

  let prompt = summaryPrompt
  while (true) {
    const reply = interrupt<string, string>(prompt)
    localMessages.push({ role: "assistant", content: prompt }, { role: "user", content: reply })

    const result = await invokeBilledCommerceLlm(state.chatbotId, [
      new HumanMessage(`Does this reply confirm placing the order? Reply with ONLY one word: yes, no, or unclear.\n\nReply: "${reply}"`),
    ])
    const verdict = String(result.content).trim().toLowerCase()

    if (verdict === "yes") {
      log().info(ctx(state), "confirm_with_customer: confirmed")
      return { messages: localMessages, validationIssue: null, responseText: "confirmed" }
    }
    if (verdict === "no") {
      log().info(ctx(state), "confirm_with_customer: declined")
      return { messages: localMessages, responseText: "No problem — let me know if you'd like to order something else." }
    }
    prompt = "Sorry, I didn't quite catch that — should I go ahead and place the order? Please reply yes or no."
  }
}
// NEW-01: a denied usage reservation ends the turn politely (see billedLlm.ts).
export const confirmWithCustomerNode = withLlmBudget(confirmWithCustomerNodeImpl, (): Partial<CommerceStateType> => ({ responseText: LLM_BUDGET_DENIED_TEXT }))


export async function finalValidationNode(state: CommerceStateType): Promise<Partial<CommerceStateType>> {
  if (state.responseText !== "confirmed") {
    
    return {}
  }

  const creds = await getDecryptedWooCommerceCredentials(state.chatbotId)
  if (!creds) {
    log().error(ctx(state), "final_validation: no WooCommerce credentials configured")
    return { responseText: "Sorry, something's wrong with this store's connection — I can't place the order right now. Please contact the store directly." }
  }

  const draft = state.orderDraft as OrderDraft
  const item = draft.lineItems[0]
  const live = await getLiveProductSnapshot(state.chatbotId, state.customerId, creds, item.wooProductId)

  if (!live.inStock || (live.quantity !== null && live.quantity < item.quantity)) {
    log().warn({ ...ctx(state), product: item.productName, requestedQty: item.quantity, availableQty: live.quantity }, "final_validation: stock changed since draft")
    return { validationIssue: `Sorry, ${item.productName} no longer has enough stock (${live.quantity ?? 0} left).`, orderDraft: { ...draft, lineItems: [{ ...item, quantity: Math.max(1, live.quantity ?? 1) }] } }
  }

  if (Math.abs(live.price - item.cachedUnitPrice) > 0.001) {
    log().warn({ ...ctx(state), product: item.productName, oldPrice: item.cachedUnitPrice, newPrice: live.price }, "final_validation: price changed since draft — stopping, not proceeding at new price")
    return {
      validationIssue: `Heads up — the price of ${item.productName} has changed to $${live.price.toFixed(2)} since we last checked.`,
      orderDraft: { ...draft, lineItems: [{ ...item, cachedUnitPrice: live.price }] },
    }
  }

  log().info(ctx(state), "final_validation: stock/price unchanged, proceeding to commit")
  return { validationIssue: null }
}


export async function commitOrderNode(state: CommerceStateType): Promise<Partial<CommerceStateType>> {
  const draft = state.orderDraft as OrderDraft
  const creds = await getDecryptedWooCommerceCredentials(state.chatbotId)
  if (!creds) {
    return { responseText: "Sorry, something's wrong with this store's connection — I can't place the order right now. Please contact the store directly." }
  }

  const customer = await resolveCustomerIdentity(state.chatbotId, draft.customerEmail as string, draft.customerPhone)
  const item = draft.lineItems[0]
  const snapshot: OrderSnapshot = {
    lineItems: [
      {
        productId: item.wooProductId,
        productName: item.productName,
        sku: null,
        quantity: item.quantity,
        unitPrice: item.cachedUnitPrice,
        subtotal: item.quantity * item.cachedUnitPrice,
      },
    ],
    shipping: 0,
    tax: 0,
    total: item.quantity * item.cachedUnitPrice,
    currency: "USD",
  }

  try {
    const result = await commitOrder({
      chatbotId: state.chatbotId,
      customerId: customer.id,
      creds,
      snapshot,
      customer: { firstName: draft.customerFirstName || "Customer", lastName: draft.customerLastName || "-", email: draft.customerEmail as string, phone: draft.customerPhone },
      idempotencyKey: state.graphRunId,
      requestId: state.requestId,
      graphRunId: state.graphRunId,
    })
    return {
      customerId: customer.id,
      committedOrderId: result.order.id,
      responseText:
        `I've created your order — it isn't confirmed yet, no booking number yet either. ` +
        `Please complete payment here to confirm it: ${result.paymentUrl}`,
    }
  } catch (err) {
    log().error({ ...ctx(state), err: err instanceof Error ? err.message : String(err) }, "commit_order failed")
    const message = err instanceof AppError ? err.message : "Sorry, something went wrong placing that order. Please try again in a moment."
    return { responseText: message }
  }
}


// CS-04 (VER-02): reached only through identify_customer/verify_code; the
// customer comes from the OTP-verified (or signed-token) identity in state,
// never from an email typed into the chat.
export async function orderStatusLookupNode(state: CommerceStateType): Promise<Partial<CommerceStateType>> {
  const customerId = verifiedCustomerIdFor(state)
  if (!customerId) return { responseText: CODE_FAILED_TEXT }
  if (!pool) throw new AppError(503, "Database is not configured. Set DATABASE_URL and JWT_SECRET.")

  const customer = { id: customerId }
  const { rows } = await pool.query("select id from commerce_orders where chatbot_id = $1 and customer_id = $2 order by created_at desc limit 1", [state.chatbotId, customer.id])
  if (!rows[0]) {
    return { customerId: customer.id, responseText: "I don't see any orders under that email." }
  }

  const orderId = rows[0].id as string

  // CS-04: the order read goes through the same tool authorization as every
  // other commerce operation (tenant, ownership, ORDER_VERIFIED level).
  // NEW-01 (CS-04 residual): authorize BEFORE anything can change the order's
  // state, so an unauthorized caller never triggers the PAID re-verification.
  try {
    await authorizeToolCall({
      chatbotId: state.chatbotId,
      customerId: customer.id,
      operation: "get_order_status",
      resource: { type: "order", id: orderId },
      requestId: state.requestId,
      graphRunId: state.graphRunId,
    })
  } catch (err) {
    if (!(err instanceof AppError)) throw err
    log().info({ ...ctx(state), orderId, status: err.status }, "order_status_lookup: get_order_status not authorized")
    return { customerId: customer.id, responseText: "I can't see a confirmed payment for your latest order yet." }
  }

  if ((await getCommerceOrder(orderId))?.status === "PENDING_PAYMENT") {
    await transitionOrderState(orderId, "PAID", { source: "manual", requestId: state.requestId, graphRunId: state.graphRunId }).catch((err) => {
      log().warn({ ...ctx(state), orderId, err: err instanceof Error ? err.message : String(err) }, "order_status_lookup: re-verification attempt did not transition (expected if genuinely still unpaid)")
    })
  }

  const order = await getCommerceOrder(orderId)
  const statusText = order?.bookingNumber
    ? `Your order is ${order.status}. Booking number: ${order.bookingNumber}.`
    : `Your order is currently ${order?.status}. ${order?.status === "PENDING_PAYMENT" ? "I don't see a confirmed payment for it yet." : ""}`

  return { customerId: customer.id, responseText: statusText.trim() }
}

export async function createSupportTicketNode(state: CommerceStateType): Promise<Partial<CommerceStateType>> {
  const latest = state.messages[state.messages.length - 1]?.content ?? ""
  const emailMatch = latest.match(/[^\s@]+@[^\s@]+\.[^\s@]+/)
  if (!emailMatch) {
    const email = interrupt<string, string>("I can help with that — what email should we follow up at?")
    return { messages: [{ role: "assistant", content: "I can help with that — what email should we follow up at?" }, { role: "user", content: email }] }
  }
  const customer = await resolveCustomerIdentity(state.chatbotId, emailMatch[0])
  const ticket = await createTicket(state.chatbotId, customer.id, latest.slice(0, 200))
  log().info({ ...ctx(state), ticketId: ticket.id }, "support ticket created")
  return { customerId: customer.id, responseText: "I've logged this with our support team — they'll follow up by email." }
}
