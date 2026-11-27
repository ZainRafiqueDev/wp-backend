# Crawl Plus Custom Actions

## Product rule

Custom Actions are available only when all of these conditions are true:

1. The chatbot owner has an active `crawl_plus` subscription.
2. The chatbot has a positive current-month top-up for Claude (`anthropic`) or OpenAI (`openai`).
3. The chatbot has its own encrypted backend API credential.
4. The action request passes the existing ownership, validation, SSRF, timeout, quota, and platform-budget checks.

Free and Full Custom subscriptions cannot configure or execute Custom Actions. Gemini top-ups do not unlock actions because the Gemini provider does not implement the tool-calling loop.

## Credential handling

- One backend API key is stored per chatbot in `chatbot_integrations`.
- The key is encrypted with `INTEGRATION_ENCRYPTION_KEY`.
- Read APIs return connection status and base URL, never the key.
- Action headers reject `Authorization`, `Proxy-Authorization`, `X-API-Key`, and `Api-Key`. This prevents credentials from being stored in plaintext action JSON.
- At execution time the decrypted chatbot credential is attached as `Authorization: Bearer <key>`.

## Billing behavior

The existing Stripe model top-up checkout credits `chatbot_model_credits` after a verified webhook. A positive current-month Claude or OpenAI credit unlocks configuration and execution. Actual LLM calls still pass through the normal reservation and reconciliation system, so plan caps, purchased credit, daily/weekly limits, and the platform budget remain enforced.

For action-relevant questions, routing is limited to the chatbot's topped-up action-capable models. Static questions continue to use the normal plan model routing. Responses containing live action data bypass the answer cache.

## Deployment requirements

- Set a strong `INTEGRATION_ENCRYPTION_KEY` in AWS.
- Configure the Claude and/or OpenAI top-up Stripe Price IDs.
- Keep the Stripe webhook signing secret configured so a successful Checkout session can credit the top-up.
- Deploy both backend and frontend changes.
- Test the sequence: activate Crawl Plus → buy model top-up → connect chatbot API key → create action → run action from the embedded chatbot.
