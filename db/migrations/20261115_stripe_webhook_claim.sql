-- CS-13 (2026-11-15): single-processor claim for Stripe webhook inbox rows.
--
-- receiveVerifiedStripeEvent used to check `processed_at is null` with a
-- plain select and then process, so two concurrent deliveries of the same
-- Stripe event (Stripe retry racing the original, or the replay job racing
-- a live delivery) could both run the grant/sync handler. The service now
-- claims the row with
--   update ... set locked_until = now() + lease
--   where processed_at is null and (locked_until is null or locked_until < now())
-- and only processes when that update returned the row. locked_until is
-- cleared when processing finishes (success or failure); a crashed
-- processor's lease simply expires.
--
-- Forward-only and idempotent: safe to run repeatedly.

alter table stripe_webhook_events add column if not exists locked_until timestamptz;
