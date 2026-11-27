import { existsSync, readFileSync } from "node:fs"

import { parse as parseDotenv } from "dotenv"
import { defineConfig } from "vitest/config"

// CS-15: test DB role passwords are not baked in. The two test URLs come
// from the shell, else from the local untracked .env; only these two keys
// are read from .env here.
const dotenvFile: Record<string, string> = existsSync(".env") ? parseDotenv(readFileSync(".env")) : {}
const testDatabaseUrl = process.env.TEST_DATABASE_URL || dotenvFile.TEST_DATABASE_URL
const testSystemDatabaseUrl = process.env.TEST_SYSTEM_DATABASE_URL || dotenvFile.TEST_SYSTEM_DATABASE_URL

// CS-17 (B09-001, B09-018, S2-011, B08-018): no test may reach a real AI
// provider or Stripe by default. Provider keys are replaced with obviously
// fake values (so the provider code paths still run, against mocked fetch)
// and Stripe/Sentry are blanked. tests/setup/testSafety.setup.ts additionally
// blocks every non-loopback network call and refuses to run if a real key
// shape is present. Deliberate live runs must opt in explicitly:
//   RUN_LIVE_AI_TESTS=1      keeps the .env AI keys and allows the provider hosts
//   RUN_LIVE_STRIPE_TESTS=1  keeps the .env Stripe keys (sk_test_ only) and allows api.stripe.com
const liveAi = process.env.RUN_LIVE_AI_TESTS === "1" || process.env.RUN_LIVE_AI_TESTS === "true"
const liveStripe = process.env.RUN_LIVE_STRIPE_TESTS === "1" || process.env.RUN_LIVE_STRIPE_TESTS === "true"

const aiKeyEnv: Record<string, string> = liveAi
  ? {}
  : {
      OPENAI_API_KEY: "test-openai-key-not-real",
      ANTHROPIC_API_KEY: "test-anthropic-key-not-real",
      GEMINI_API_KEY: "test-gemini-key-not-real",
    }
const stripeEnv: Record<string, string> = liveStripe ? {} : { STRIPE_SECRET_KEY: "", STRIPE_WEBHOOK_SECRET: "" }

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // CS-17 testSafety runs first (egress block, key scan); then CS-15/B09-017:
    // context-less fixture queries run as system scope only because this file
    // opts in; production has no such default.
    setupFiles: ["tests/setup/testSafety.setup.ts", "tests/setup/implicitSystemContext.ts"],
    // Injected into process.env before any test file (and therefore
    // src/env.ts's `dotenv/config`, which never overrides an already-set
    // var) loads — see .env.test.example for the long-form explanation of
    // each one. A distinct CRAWL_QUEUE_NAME keeps a real local dev worker
    // (listening on the default "crawl-queue") from ever picking up a job
    // enqueued by a test run.
    env: {
      // CS-15: no role password is baked in here any more. Set
      // TEST_DATABASE_URL (chatmate360_app) and TEST_SYSTEM_DATABASE_URL
      // (chatmate360_system) in the shell or the untracked .env (see
      // docs/RLS.md "Running tests locally"), or PGPASSWORD / ~/.pgpass.
      DATABASE_URL: testDatabaseUrl || "postgresql://chatmate360_app@127.0.0.1:5435/chatmate360_test",
      SYSTEM_DATABASE_URL: testSystemDatabaseUrl || "postgresql://chatmate360_system@127.0.0.1:5435/chatmate360_test",
      JWT_SECRET: "test-only-secret-do-not-use-in-production",
      REDIS_URL: process.env.TEST_REDIS_URL || "redis://127.0.0.1:6379",
      CRAWL_QUEUE_NAME: "crawl-queue-test",
      COMMERCE_QUEUE_NAME: "commerce-queue-test",
      DOCUMENT_INGEST_QUEUE_NAME: "document-ingest-test",
      DOCUMENT_STORAGE_DRIVER: "fs",
      DOCUMENT_STORAGE_DIR: "var/document-storage-test",
      DOCUMENT_SCAN_VENDOR: "mock",
      DOCUMENT_SCAN_SKIP: "false",
      DOCUMENT_SCAN_FAIL_CLOSED: "true",
      DOCUMENT_SCAN_PAUSE_UPLOADS: "false",
      RETRIEVAL_MODE: "hybrid",
      RETRIEVAL_TS_CONFIG: "simple",
      EMBEDDING_BUDGET_ENABLED: "true",
      EMBEDDING_DIM: "1536",
      EMBEDDING_REEMBED_ON_SWEEP: "false",
      RAG_EVAL_SKIP: "false",
      FRONTEND_URL: "https://frontend.test",
      PUBLIC_CHAT_RATE_LIMIT_PER_MIN: "8",
      PUBLIC_CHAT_RATE_LIMIT_STRICT_PER_MIN: "3",
      AUTHENTICATED_CHAT_RATE_LIMIT_PER_MIN: "5",
      // 15, not something tiny — the per-conversation-cap test needs 10
      // uploads to one chatbot from this same test-harness IP, and the
      // limiter key is chatbotId+IP, so it must comfortably clear that
      // before the per-IP-cap test (which uses its own, different chatbot
      // and pushes past this value deliberately) exercises the real limit.
      ATTACHMENT_MAX_PER_IP_PER_DAY: "15",
      DEMO_MODE: "sandbox",
      // Blanked out deliberately: the real local .env's OLLAMA_BASE_URL
      // (a self-hosted, optional fallback provider) otherwise leaks into
      // tests unchanged, since dotenv never overrides an already-set var
      // but this was never set by vitest until now. answerQuestion's
      // fallback-reauthorization loop (ai.ts) correctly tries Ollama as a
      // real candidate whenever an earlier provider is denied/fails — that
      // exposed this leak: with a real (but not-actually-running) Ollama
      // URL configured, that attempt is a genuine network call to a closed
      // local port, whose own aiRequestTimeoutMs default (30s) is longer
      // than this suite's test timeout (15s), so the TEST times out first
      // rather than the fetch failing on its own terms. Ollama is the one
      // provider no test should depend on a locally-running server for.
      // The hosted providers are handled by aiKeyEnv above (CS-17).
      OLLAMA_BASE_URL: "",
      ...aiKeyEnv,
      ...stripeEnv,
      // Never report test errors to a real Sentry project (CS-17).
      SENTRY_DSN: "",
      // Standing credentials no test needs from a developer's shell/.env
      // (CS-17). Tests that need one set a fake value themselves
      // (googleOAuth sets its own Google client). The setup file refuses to
      // run if any such credential is still non-empty.
      GOOGLE_CLIENT_SECRET: "",
      DOCUMENT_STORAGE_ACCESS_KEY: "",
      DOCUMENT_STORAGE_SECRET_KEY: "",
      AWS_ACCESS_KEY_ID: "",
      AWS_SECRET_ACCESS_KEY: "",
      AWS_SESSION_TOKEN: "",
      // Test-only dummy key (32 bytes, hex). Without it the
      // encryption-first cross-tenant checks used to silently return early
      // (B09-003); they now assert it is configured instead.
      INTEGRATION_ENCRYPTION_KEY: "7e57000000000000000000000000000000000000000000000000000000c51700",
      // Same leak as OLLAMA_BASE_URL above: the real local .env now has a
      // genuine CALENDLY_WEBHOOK_SIGNING_KEY (webhook setup for local dev),
      // which would otherwise flip leads.integration.test.ts's "webhook
      // isn't configured" 503 check into a signature-verification failure
      // instead. Blanked so the test suite's Calendly config stays
      // independent of whatever's set up for manual local testing.
      CALENDLY_WEBHOOK_SIGNING_KEY: "",
      // Same leak as OLLAMA_BASE_URL/CALENDLY_WEBHOOK_SIGNING_KEY above —
      // the real local .env has a genuine, live RESEND_API_KEY, and no test
      // file mocks src/lib/email.ts's fetch call to Resend. Without this,
      // any signup/OTP/password-reset test would make a real API call to
      // Resend with a real key. Blanked so sendEmail() always takes its
      // already-safe "no key configured" no-op path (logs + returns
      // { delivered: false }) during tests, never a live network call.
      RESEND_API_KEY: "",
      // The platform-wide ceiling (tokenallocation.md §2) sums cost across
      // EVERY chatbot ever created in chatmate360_test, not just the one a
      // given test creates — and this DB accumulates real chatbot_usage
      // rows across every test run ever executed against it, with no
      // full-table reset between runs. A real-world default here would
      // eventually (and unpredictably) start rejecting reservations in
      // tests that have nothing to do with the platform ceiling itself.
      // Set high enough to never bind unless a test is specifically
      // exercising the platform ceiling (which reads env.platform*CapUsd
      // directly rather than hardcoding a number, so it stays correct
      // regardless of what this is set to).
      PLATFORM_MONTHLY_COST_CAP_USD: "1000000",
      PLATFORM_WEEKLY_COST_CAP_USD: "1000000",
      PLATFORM_DAILY_COST_CAP_USD: "1000000",
      // Admin login is IP-keyed. WP-2.6 adds several activate-plan helpers
      // that sign in in parallel with adminAuth tests; the production 10/min
      // cap would 429 the suite, not the product.
      ADMIN_LOGIN_RATE_LIMIT_PER_MIN: "1000",
      // Same reasoning for customer /auth/login — every test file that signs
      // a user in more than 10 times per suite run would otherwise 429.
      // tests/integration/rateLimitLogin.integration.test.ts stubs this back
      // down to a small number for its own isolated assertions.
      LOGIN_RATE_LIMIT_PER_MIN: "1000",
      // CS-09 limiters: the suite signs up / signs in / sends OTPs from one
      // loopback IP (and reuses emails) far more than production caps
      // allow. tests/integration/rateLimitAuthCs09.integration.test.ts
      // stubs these back down with unique keys for its own assertions.
      LOGIN_EMAIL_RATE_LIMIT_PER_15_MIN: "100000",
      ADMIN_LOGIN_EMAIL_RATE_LIMIT_PER_15_MIN: "100000",
      OTP_SEND_EMAIL_RATE_LIMIT_PER_15_MIN: "100000",
      // CS-17: the per-IP OTP/forgot-password buckets are keyed on the one
      // loopback address every test file (and any concurrent run against
      // the same Redis) shares; the 5/min defaults 429'd otpAndPasswordReset
      // depending on what else was running. rateLimitAuthCs09 still stubs
      // these back down with its own random IPs.
      OTP_SEND_RATE_LIMIT_PER_MIN: "100000",
      OTP_VERIFY_RATE_LIMIT_PER_MIN: "100000",
      PASSWORD_FORGOT_RATE_LIMIT_PER_MIN: "100000",
      OTP_VERIFY_EMAIL_RATE_LIMIT_PER_15_MIN: "100000",
      PASSWORD_FORGOT_EMAIL_RATE_LIMIT_PER_15_MIN: "100000",
      PASSWORD_RESET_RATE_LIMIT_PER_MIN: "100000",
      SIGNUP_RATE_LIMIT_PER_MIN: "100000",
      SIGNUP_EMAIL_RATE_LIMIT_PER_15_MIN: "100000",
      VERIFY_EMAIL_RATE_LIMIT_PER_MIN: "100000",
      RESEND_VERIFICATION_RATE_LIMIT_PER_MIN: "100000",
      RESEND_VERIFICATION_USER_RATE_LIMIT_PER_15_MIN: "100000",
      // Audit 2026-11-27 public form limiter (leads/contact/trial/waitlist/demo).
      PUBLIC_FORM_RATE_LIMIT_PER_MIN: "100000",
      RLS_ENABLED: "true",
      RLS_APP_ROLE: "chatmate360_app",
      DB_POOL_MAX: "40",
    },
    // bcrypt at 12 rounds (~100-300ms/call) plus real Postgres/Redis round
    // trips in the integration suite run comfortably under this, but the
    // vitest default (5s) is tight once a few of those stack up in one test.
    testTimeout: 30000,
    hookTimeout: 20000,
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**/*.ts"],
    },
  },
})
