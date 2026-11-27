-- CS-07 (2026-11-14): atomic "one auto-purchase per chatbot per UTC day".
--
-- tryAutoPurchaseTopup used to check for an earlier attempt with a plain
-- select and then insert an 'attempted' row, so concurrent public chat
-- requests could all pass the check and each charge the owner's card.
-- The service now inserts its claim row first with
-- `on conflict (chatbot_id, claim_day) where claim_day is not null do nothing`
-- and only calls Stripe when that insert returned a row.
--
-- claim_day is set only on the claim row (the 'attempted' row the service
-- inserts before charging; it is later updated in place to 'succeeded',
-- 'failed' or 'charged_not_credited'). 'skipped' rows and other history rows leave it null, so they
-- never block a claim.
--
-- Idempotent: safe to run repeatedly and on a database that already has
-- auto_purchase_events rows.

alter table auto_purchase_events add column if not exists claim_day date;

-- Backfill: give the earliest 'attempted'/'succeeded' row of each
-- (chatbot, UTC day) the claim, so existing history (in particular an
-- attempt already made today) keeps blocking a second charge after deploy.
-- Older duplicates (the race this migration fixes) stay null so the
-- unique index below can be built. The not-exists guard makes a re-run a
-- no-op.
update auto_purchase_events e
   set claim_day = d.claim_day
  from (
    select distinct on (chatbot_id, (created_at at time zone 'utc')::date)
           id, (created_at at time zone 'utc')::date as claim_day
      from auto_purchase_events
     where status in ('attempted', 'succeeded')
     order by chatbot_id, (created_at at time zone 'utc')::date, created_at, id
  ) d
 where e.id = d.id
   and e.claim_day is null
   and not exists (
     select 1 from auto_purchase_events x
      where x.chatbot_id = e.chatbot_id and x.claim_day = d.claim_day
   );

create unique index if not exists uq_auto_purchase_events_daily_claim
    on auto_purchase_events (chatbot_id, claim_day)
    where claim_day is not null;

-- 'charged_not_credited': Stripe charged the card but creditTopup failed.
-- Kept distinct from 'failed' (no successful charge) so it can be found and
-- reconciled (credit or refund the PaymentIntent named in detail).
alter table auto_purchase_events drop constraint if exists auto_purchase_events_status_check;
alter table auto_purchase_events add constraint auto_purchase_events_status_check
    check (status in ('attempted', 'succeeded', 'failed', 'skipped', 'charged_not_credited'));
