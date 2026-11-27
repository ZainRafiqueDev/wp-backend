-- SA-01 (2026-11-16): platform admin roles.
--
-- admin_users.role:      'super_admin' or 'admin'. Every existing admin keeps
--                        today's capabilities as a plain 'admin'. Promote the
--                        first super admin with `npm run seed-super-admin`
--                        (docs/ADMIN.md).
-- admin_users.is_active: an inactive admin cannot sign in, and
--                        requireAdminAuth refuses its existing sessions
--                        (deactivation also moves tokens_valid_after).
--
-- "At least one active super_admin" is enforced by the service layer
-- (src/services/admin/adminManagement.service.ts) under a row lock, not by a
-- constraint, so the very first super admin can be seeded into a database
-- that has none.
--
-- Forward-only and idempotent: safe to run more than once. admin_users stays
-- revoked from chatmate360_app (CS-15); chatmate360_system's table-level
-- grants already cover the new columns.
alter table admin_users add column if not exists role text not null default 'admin';
alter table admin_users add column if not exists is_active boolean not null default true;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'admin_users_role_check' and conrelid = 'public.admin_users'::regclass
  ) then
    alter table admin_users add constraint admin_users_role_check check (role in ('super_admin', 'admin'));
  end if;
end $$;

-- Case-insensitive email lookups (login, uniqueness checks). Emails are
-- stored lower-cased by every write path.
create index if not exists idx_admin_users_lower_email on admin_users (lower(email));
