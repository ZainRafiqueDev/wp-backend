-- Phase 2 (2026-10-27): team members. v1 ships 3 roles (owner, admin,
-- viewer) — "owner" is never a row here, it's whoever's user_id the
-- workspace is keyed by (subscriptions.user_id / chatbots.user_id), exactly
-- as today. A row in workspace_members is an ADMIN or VIEWER member of that
-- owner's workspace. "One membership per user for v1" (see tokenallocation
-- / Phase 2 notes) is enforced by member_user_id being unique: a user can
-- be a member of at most one workspace at a time, and cannot simultaneously
-- be an owner (own chatbots) and a member of someone else's workspace —
-- enforced in application code (src/lib/tenancy.ts), not here.
create table if not exists workspace_members (
    id              uuid primary key default gen_random_uuid(),
    owner_user_id   uuid not null references users(id) on delete cascade,
    member_user_id  uuid not null unique references users(id) on delete cascade,
    role            text not null,
    invited_by      uuid references users(id) on delete set null,
    created_at      timestamptz not null default now(),

    constraint workspace_members_role_check check (role in ('admin', 'viewer')),
    constraint workspace_members_not_self check (owner_user_id <> member_user_id)
);
create index if not exists idx_workspace_members_owner on workspace_members (owner_user_id);

create table if not exists workspace_invitations (
    id              uuid primary key default gen_random_uuid(),
    owner_user_id   uuid not null references users(id) on delete cascade,
    email           text not null,
    role            text not null,
    token_hash      text not null unique,
    status          text not null default 'pending',
    invited_by      uuid not null references users(id) on delete cascade,
    expires_at      timestamptz not null,
    created_at      timestamptz not null default now(),
    accepted_at     timestamptz,
    revoked_at      timestamptz,

    constraint workspace_invitations_role_check check (role in ('admin', 'viewer')),
    constraint workspace_invitations_status_check check (status in ('pending', 'accepted', 'revoked', 'expired'))
);
create index if not exists idx_workspace_invitations_owner on workspace_invitations (owner_user_id);
create index if not exists idx_workspace_invitations_email_pending on workspace_invitations (lower(email)) where status = 'pending';

-- Separate from admin_audit_log (platform-admin actions, admin_user_id FK to
-- admin_users) — this records a workspace OWNER/ADMIN acting on their own
-- team, keyed by the real actor (never the resolved tenant/owner id — see
-- resolveTenantContext in src/lib/tenancy.ts), so "who actually clicked
-- this" is always recoverable even when they acted as a member.
create table if not exists workspace_audit_log (
    id              uuid primary key default gen_random_uuid(),
    owner_user_id   uuid not null references users(id) on delete cascade,
    actor_user_id   uuid not null references users(id) on delete cascade,
    action          text not null,
    detail          jsonb not null default '{}',
    created_at      timestamptz not null default now()
);
create index if not exists idx_workspace_audit_log_owner on workspace_audit_log (owner_user_id, created_at desc);
