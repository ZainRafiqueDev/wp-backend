# src/controllers

Deliberately thin (the biggest is 125 lines, most are under 40) — every controller here follows the same three-line shape: pull the bearer token / route params, await one service call, `res.status(...).json(...)`. Every export is wrapped in `src/middleware/asyncHandler.ts`. **No controller talks to Postgres/Redis directly, parses business rules, or checks ownership itself** — that's `src/services/`'s job; a controller that starts doing either of those has drifted from the pattern.

One file per route group, matching `src/routes/`:

- **`auth.controller.ts`** (125 lines, the largest) — `signupUser`, `loginUser`, `startGoogle`/`completeGoogle`, `currentUser`, `refreshUserSession`, `logoutUser`, `verifyEmailUser`/`resendVerificationEmail` (legacy link-based verification), `updateAutoPurchase`, `forgotPasswordUser`/`resetPasswordUser`, `sendOtpCode`/`verifyOtpCode` (the newer OTP flow — see `src/services/otp.service.ts` and `src/validators/README.md`).
- **`chatbot.controller.ts`** (99 lines) — `getChatbots`, `createFirstChatbot`, `retryChatbot`, `setTheme`/`setDomain`/`setFallbackMessage`/`setPreferredModel`, `getUsageSummary` (calls both `getUsageSummaryForOwner` *and* `getUsageWindowSummariesForOwner` in parallel — see `src/services/usage.service.ts`), `getAnalyticsSummary`, `getStatus`, `chatWithChatbot` (the authenticated dashboard preview-chat endpoint).
- **`billing.controller.ts`** — `getSummary`, `postCheckoutSession`, `postPortalSession`, `postTopupSession`.
- **`admin.controller.ts`** — `postAdminLogin`, `getAdminUsers`, `postDeactivateUser`/`postActivateUser`, `deleteAdminUser`, `getAdminUserUsage`, `getAdminAbuseFlags`/`postReviewAbuseFlag`.
- **`notifications.controller.ts`** — `getNotifications`, `readNotification`, `readAllNotifications`. Note: unlike most controllers here, this one calls `verifyAccessToken(getBearerToken(req))` itself rather than delegating that check into the service — a small inconsistency worth knowing about if you're pattern-matching from this file specifically.
- **`documents.controller.ts`** — `getDocuments`, `postDocument` (reads `req.file` off multer, see `src/middleware/uploadDocument.ts`), `removeDocument`.
- **`liveData.controller.ts`** — `getLiveData`, `postLiveData`, `patchLiveData`, `removeLiveData`.
- **`integration.controller.ts`** — `getIntegration`, `putIntegration`, `removeIntegration` (a chatbot's own backend-link API key, for Custom Actions).
- **`actions.controller.ts`** — `getActions`, `postAction`, `putAction`, `removeAction` (Custom Actions CRUD; active Crawl Plus and model-top-up gates live in the service layer).
- **`booklyCredentials.controller.ts`** — `getBooklyStatus`, `postBooklyConnect`, `deleteBooklyConnection`, `getBooklyMeetingHistoryReport` (streams a PDF).
- **`booklyAdminChat.controller.ts`** — `postBooklyAdminChat`, `getBooklyAdminAuditLog` — the separate admin-chat-automation entry point (see `src/langgraph/README.md` and `PROJECT_STATE.md` §4.5 for the distinct auth path this uses).
- **`commerceWooCommerce.controller.ts`** — `getWooCommerceStatus`, `postWooCommerceConnect`, `deleteWooCommerceConnection`, `postWooCommerceSync`.
- **`commerceWebhook.controller.ts`** — `postWooCommerceWebhook`, the WooCommerce webhook receiver. Mounted directly in `src/app.ts` (not via `routes/index.ts`) with `express.raw()` ahead of the global JSON parser — the handler needs the untouched raw body to verify `verifyWooCommerceWebhookSignature` (`src/lib/woocommerce/webhookSignature.ts`).
- **`public.controller.ts`** — `getWidgetConfig`, `postWidgetChat` — the embeddable widget's own two endpoints, no auth, origin-checked instead (`src/services/public.service.ts`).
- **`health.controller.ts`, `contact.controller.ts`, `trial.controller.ts`, `demo.controller.ts`, `waitlist.controller.ts`** — one-function files for simple public/marketing endpoints (`createContact`, `createTrial`, `createDemoChat`, `createWaitlistSignup`).
