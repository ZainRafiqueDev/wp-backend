-- WP-2.6: optional activation audit columns on subscriptions.
-- Plan already supports full_custom. These record who activated a
-- Full Custom contract and when. Apply on existing DBs. New DBs get
-- the same columns from schema.sql.

alter table subscriptions add column if not exists activated_by uuid references admin_users(id) on delete set null;
alter table subscriptions add column if not exists activated_at timestamptz;
