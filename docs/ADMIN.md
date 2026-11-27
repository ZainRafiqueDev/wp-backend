# Platform admins and super admins (SA-01)

## Roles

`admin_users.role` is `super_admin` or `admin` (migration `db/migrations/20261116_admin_roles.sql`, wired into `db/schema.sql`). `admin_users.is_active` turns an admin off.

| Capability | admin | super_admin |
|---|---|---|
| Every admin endpoint that existed before SA-01 (customer list/detail, activate/deactivate/delete, usage, plans, pricing, metrics, alerts…) | yes | yes |
| `GET /admin/workspaces` — all customer accounts with member, pending-invitation and chatbot counts (`search`, `limit` ≤ 100, `offset`) | 403 | yes |
| `GET /admin/users/:id/members` — workspace members (email, role, joined) and pending/expired invitations. Never returns token values | 403 | yes |
| `GET /admin/users/:id/chatbots` — chatbots (id, name, created, status, active, document count), read-only | 403 | yes |
| `GET /admin/admins`, `POST /admin/admins`, `PATCH /admin/admins/:id` (`role`, `name`, `isActive`), `POST /admin/admins/:id/revoke-sessions` | 403 | yes |

Rules:
- `requireAdminAuth` reads `role`, `is_active` and `tokens_valid_after` from the database on every request. The role is **not** in the token, so a demotion applies to the next request of every open session.
- An inactive admin cannot sign in (same "Invalid email or password." answer as a wrong password) and every existing session gets 401. Deactivation also moves `tokens_valid_after`, so reactivating later does not bring old cookies back.
- At least one active super admin always remains. Every change that could remove one locks all active super admin rows first, so two super admins demoting each other at the same moment cannot both succeed.
- A super admin cannot change their own role, deactivate themselves, or revoke their own sessions through these endpoints (use sign out).
- Every super-admin endpoint, including the read-only views, writes `admin_audit_log` (target admin ids go in `detail.targetAdminId`; no secrets).
- All of it runs on the system login (`runWithSystemContext`). `admin_users` stays unreadable to `chatmate360_app` (CS-15).

## Own credentials: `PATCH /admin/account`

Body: `{ currentPassword, newEmail?, newPassword? }`.
- `currentPassword` is always required; a wrong one gets 401 and is audit-logged (`update_admin_account_failed`).
- Password policy for every admin password (this endpoint, `POST /admin/admins`, the seed script): at least 12 characters, not blank, at most 72 bytes (bcrypt's limit).
- Email is trimmed, lower-cased and must be unique across admins case-insensitively (409 otherwise).
- On success the update and `tokens_valid_after` move happen in one transaction under the admin row lock. Every other session is signed out and the current browser gets a fresh cookie.
- Rate limit: 10 attempts per admin account per 15 minutes (insured limiter, never unlimited when Redis is down). Admin login keeps its per-IP and per-email limits (`ADMIN_LOGIN_RATE_LIMIT_PER_MIN`, `ADMIN_LOGIN_EMAIL_RATE_LIMIT_PER_15_MIN`).

## Seeding the first super admin

`npm run seed-super-admin [-- --reset-password]` (`scripts/seedSuperAdmin.ts`). It needs `DATABASE_URL`, `SYSTEM_DATABASE_URL` and `JWT_SECRET` like the API, and runs on the system login.

| Variable | Meaning |
|---|---|
| `SUPER_ADMIN_EMAIL` | Required. |
| `SUPER_ADMIN_PASSWORD` | Optional. At least 12 characters, or the script refuses. |
| `SUPER_ADMIN_CREDENTIALS_FILE` | Required when `SUPER_ADMIN_PASSWORD` is absent and a password must be set. Absolute path **outside the repository**. The script generates a 32-character random password (`crypto.randomBytes`) and writes the email and password only to this file (mode 0600). It never overwrites an existing file and never logs or prints the password. |
| `SUPER_ADMIN_NAME` | Optional display name for a new admin. |

Behaviour (idempotent):
- New email: creates an active `super_admin`.
- Existing email: promotes it to `super_admin` and re-activates it. The password is changed **only** with `--reset-password`, which also signs that admin out everywhere.
- Re-running with nothing to change does nothing (`action: "unchanged"`).

### Production

Run it once at deploy, after the migration, with the variables injected from the secret store (never committed, never in shell history):

```sh
psql "$ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 -f db/migrations/20261116_admin_roles.sql
SUPER_ADMIN_EMAIL=... SUPER_ADMIN_CREDENTIALS_FILE=/run/secrets-out/super-admin.txt npm run seed-super-admin
```

Then read the credentials file once, sign in, **change the password at once** (Account page, which signs out every other session), and delete the file. Create the other admins from the Admins page instead of re-running the script. `npm run create-admin` still creates plain admins.
