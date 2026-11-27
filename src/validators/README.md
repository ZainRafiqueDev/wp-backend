# src/validators

Zod schemas, one file per route group, consumed exclusively via `src/middleware/validate.ts`'s `validateBody(schema)` / `validateParams(schema)` — a validator file has no other job than defining schemas + the `z.infer<>` types controllers import for their input types. None of these files touch the database or call any service.

Grouped by what they gate (file → schemas):

**Auth & account** (`auth.validator.ts`, the largest — 79 lines, actively growing):
`signupSchema`, `loginSchema`, `refreshSchema` — core session schemas.
`verifyEmailSchema` — the legacy link-based email verification (`POST /auth/verify-email`), still live alongside OTP.
`forgotPasswordSchema` / `resetPasswordSchema` — canonical `POST /auth/password/forgot|reset` (also mounted under legacy aliases `/auth/forgot-password`/`/auth/reset-password` in `auth.routes.ts`).
`otpPurposeSchema` (`"EMAIL_VERIFY" | "ORDER_ACCESS" | "SENSITIVE_ACTION"` — deliberately **excludes** `PASSWORD_RESET`, which uses the separate reset-token flow above, not OTP), `sendOtpSchema`, `verifyOtpSchema` — the OTP flow (`POST /auth/otp/send`, `/auth/otp/verify`).
`autoPurchaseSchema` — the dashboard's auto-purchase-usage-credit toggle input.

**Chatbot lifecycle** (`chatbot.validator.ts`, 77 lines): `chatbotSourceSchema` (a `ChatbotSource` — `type: "website"|"pdf"|"word"`, note `pdf`/`word` sources never get real `content` populated at onboarding time, see `PROJECT_STATE.md` §2), `themeSchema` (hex-color triple), `createChatbotSchema` (name + sources + optional `websiteUrl`/`theme`), `updateThemeSchema`, `updateDomainSchema` (the widget's `allowed_domain`), `updateFallbackMessageSchema`, `updatePreferredModelSchema`, `chatSchema` (dashboard preview chat), `chatbotIdParamSchema` (reused as the `:chatbotId` param schema by many *other* route files too — actions, documents, live-data, integration, WooCommerce, Bookly — rather than each redefining `z.object({ chatbotId: z.string().guid() })`), `retryChatbotSchema`.

**Custom Actions** (`actions.validator.ts`): `actionParameterSchema`, `createActionSchema`/`updateActionSchema` (same shape, aliased), `actionIdParamSchema`.

**Documents (Crawl Plus ingestion)** (`documents.validator.ts`, 6 lines — deliberately tiny): only `documentIdParamSchema` (`{chatbotId, id}`, for the delete route) — the upload/list routes reuse `chatbot.validator.ts`'s `chatbotIdParamSchema` directly rather than duplicating it.

**Live data** (`liveData.validator.ts`): `createLiveDataSchema`, `updateLiveDataSchema`, `liveDataIdParamSchema` — the owner-set key/value facts merged into AI context ahead of crawled content (`chatbot_live_data`).

**Integrations** (`integration.validator.ts`): `upsertIntegrationSchema` — a chatbot's own backend-link API key/base URL for Custom Actions' `executeAction`.

**Commerce** (`commerceWooCommerce.validator.ts`: `connectWooCommerceSchema`; `booklyCredentials.validator.ts`: `connectBooklySchema`; `booklyAdminChat.validator.ts`: `booklyAdminChatSchema`) — each gates its respective connect-a-third-party-service route.

**Billing** (`billing.validator.ts`): `createCheckoutSessionSchema` (backend resolves the real Stripe Price ID server-side from the plan code — the browser only ever sends `plan: "crawl_plus" | "full_custom"`, never a price id, per `CHATMATE360_SESSION_UPDATE.md` §11's explicit security note), `createTopupSessionSchema`.

**Admin** (`admin.validator.ts`): `adminLoginSchema`, `idParamSchema`, `deleteUserSchema` (`{ confirm: z.literal(true) }` — a user-delete request without the literal `confirm: true` is rejected by the schema itself, before the controller ever runs, so a delete can't happen from a body that merely happens to be truthy-ish). `activatePlanSchema` (WP-2.6): `{ plan, monthlyCreditUsd, allowedModels, cashCollectedUsd, overrideReason? }`.

**Public/marketing-site forms** (`public.validator.ts` — the *public widget chat* schema, not marketing forms despite the name; `demo.validator.ts`, `contact.validator.ts`, `waitlist.validator.ts`, `trial.validator.ts`) — each a small, single-purpose schema for an unauthenticated public route.

Convention worth following if you add a new one: name the schema `verbNounSchema`, export the matching `z.infer<>` as `VerbNounInput`, and if a route needs a `:xyzId` param schema that already exists elsewhere (most commonly `chatbotIdParamSchema`), import it rather than redefining an equivalent one.
