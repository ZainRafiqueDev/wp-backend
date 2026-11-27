// The exact request bodies to POST to
// `https://<your-chatmate360-backend>/chatbots/:chatbotId/actions` (Full
// Custom plan only) to wire this adapter's two write endpoints up as tool
// calls the chatbot's model can make mid-conversation. Shaped to match
// src/validators/actions.validator.ts's createActionSchema field-for-field.
// See README.md's "Contract adjustments" section for why `quantity` is a
// string template even though it's conceptually a number.
//
// Replace API_BASE_URL with this adapter's real deployed URL before
// registering — kept relative here only so
// tests/customActionContract.test.ts can resolve these against an
// in-process app without a real hostname.

export const API_BASE_URL = "https://your-woocommerce-adapter.example.com"

export const CREATE_ORDER_ACTION = {
  name: "create_order",
  description:
    "Place a real purchase order for the customer. Only call this after the customer has confirmed the product and quantity, and you have their name and email.",
  httpMethod: "POST",
  urlTemplate: "/orders",
  headersTemplate: {},
  bodyTemplate: {
    productId: "{{product_id}}",
    quantity: "{{quantity}}",
    customer: { name: "{{customer_name}}", email: "{{customer_email}}" },
  },
  parameters: [
    { name: "product_id", type: "string", description: "The product's id.", required: true },
    { name: "quantity", type: "number", description: "How many units to order.", required: true },
    { name: "customer_name", type: "string", description: "The customer's full name.", required: true },
    { name: "customer_email", type: "string", description: "The customer's email address.", required: true },
  ],
}

export const UPDATE_INVENTORY_ACTION = {
  name: "update_inventory",
  description: "Set a product's absolute stock count. Use for an explicit restock/adjustment request, not as a side effect of a purchase.",
  httpMethod: "PATCH",
  urlTemplate: "/products/{{product_id}}/inventory",
  headersTemplate: {},
  bodyTemplate: { quantity: "{{quantity}}" },
  parameters: [
    { name: "product_id", type: "string", description: "The product's id.", required: true },
    { name: "quantity", type: "number", description: "The new absolute stock count.", required: true },
  ],
}
