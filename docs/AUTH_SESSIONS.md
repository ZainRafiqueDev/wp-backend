# Auth sessions

How the three kinds of client authenticate against the API, before and after CS-11 (2026-11-14).

## Before CS-11

| Client | Credential | Where it lives | Revocation |
|---|---|---|---|
| Dashboard users | `chatmate360_access_token` (JWT, `typ: access`, 7 days) and `chatmate360_refresh_token` (opaque, 30 days, sha256 in `refresh_tokens`) | httpOnly cookies set by the API. `SameSite=None; Secure` in production because the frontend (`*.vercel.app`) and the API are different sites; `Lax` in dev | Refresh tokens are deleted on logout and password reset. Access tokens were stateless: valid until expiry, even after logout, deactivation or password reset. `requireAuth` only checked that a token was present |
| Admin UI | Admin JWT (`typ: admin`, 8 h) returned in the `/admin/login` response body | `sessionStorage` in the browser, sent as `Authorization: Bearer` | None. The route guard was client-side only (token present in sessionStorage) |
| Widget (`/public/*`) | No cookies. Public chatbot id, plus an optional widget customer-session JWT sent explicitly | n/a | n/a. **Must stay cookie-free.** |

CSRF: `requireTrustedOrigin` (global) refuses state-changing requests that carry an auth cookie unless `Origin` (or `Referer`) is `FRONTEND_URL`.

## After CS-11

### Dashboard users
- Access token TTL default is **15 minutes** (`ACCESS_TOKEN_TTL_SECONDS`). The dashboard's API client calls `POST /auth/refresh` once on a 401 and retries, so users stay signed in for the refresh token's lifetime.
- Each sign-in has a **session id** (`refresh_tokens.session_id`). It is kept across refresh rotation and embedded in the access token as `sid`. Access tokens also carry `iat_ms`, taken from the **database clock** (the session row's `created_at`, written with `clock_timestamp()`). Watermarks are written with the same clock, so app instances with skewed clocks cannot misorder a token and a revocation.
- `requireAuth` does one cache-free DB check per request and rejects the token when any of these is true:
  - the user is missing or `is_active = false`;
  - `iat_ms < users.tokens_valid_after`;
  - the token has no `sid` (pre-CS-11 or issued by an old instance), or its `sid` has no live, unrotated refresh token.

  Why no cache: a Redis cache would leave a TTL-long window in which a revoked session still works, and every revocation path would have to invalidate it. The query is a primary-key lookup plus an indexed `exists`.
- `users.tokens_valid_after` is moved to `clock_timestamp()` and all refresh tokens are deleted, in one transaction that locks the `users` row, on:
  - `POST /auth/logout-all` (new);
  - password reset;
  - Google link of an unverified account (CS-05 path);
  - admin deactivation.
- `POST /auth/logout` deletes every refresh token of the session, found from the refresh token in the cookie or body and from the access token's `sid`. It does this under the `users` row lock, like every revocation, so a refresh in flight cannot leave a token behind. Replaying the old access cookie or the old refresh cookie afterwards gets a 401.
- Login (dashboard and admin) checks the password with bcrypt, then issues the session in a transaction that locks the `users` / `admin_users` row. It re-checks there that the verified hash is still the current one and that the account is still active. A password reset, Google takeover, deactivation or admin credential change that lands while bcrypt runs therefore cannot leave a fresh session alive.
- `POST /auth/refresh` runs in one transaction that first locks the `users` row, the same lock every revocation takes. A refresh and a revocation are therefore serialized: either the refresh commits first and the revocation deletes its new token, or the revocation commits first and the refresh finds its token gone. Refresh also rejects inactive users and tokens created before `tokens_valid_after`.
- Reuse detection: a used refresh token is marked `rotated_at` instead of being deleted. Presenting it again more than 30 s after rotation is treated as theft and deletes the whole session (all its refresh tokens, so its access tokens die too). Within 30 s the outcome depends on the client:
  - If the User-Agent fingerprint (sha256, stored as `refresh_tokens.client_fingerprint`) differs from the client the token was issued to, it is treated as theft too.
  - Otherwise it is only refused, because two tabs of one browser refreshing at once is normal; the dashboard then retries with the cookie the other tab received.
  
  Every reuse is logged as the `auth.refresh_token_reuse` security event, with no token values. IP is not compared, because it changes legitimately (mobile, VPN). Rotated rows are pruned after 7 days.
- Workspace invites: inviting, resending and accepting need a verified email. When Google takes over an unverified account, the link transaction removes:
  - members that account added to its own workspace;
  - its pending invitations;
  - its own memberships in other workspaces.

### Admin UI
- `/admin/login` sets an httpOnly cookie and returns only `{ ok, admin }`. The token is no longer in the body.
  - Production cookie: `__Host-chatmate360_admin_token; Secure; SameSite=None; Path=/`. It is host-only (no `Domain`), which is what `__Host-` requires, and the prefix stops sibling subdomains from planting or overwriting the cookie. `SameSite=None` is needed because the admin UI and the API are cross-site.
  - Dev cookie: `chatmate360_admin_token; SameSite=Lax`. Dev runs over plain HTTP, so the cookie cannot be Secure, and that rules out the `__Host-` prefix.
- CSRF: `requireTrustedOrigin` treats the admin cookie like the dashboard cookies.
- `requireAdminAuth` reads the admin cookie only (the Bearer path was removed in the review round) and checks `admin_users.tokens_valid_after` on every request. `POST /admin/logout` and any email or password change move that watermark, which signs the admin out on every device. A credential change re-issues the cookie for the current browser.
- SA-01: `requireAdminAuth` also refuses an admin whose `is_active` is false and reads `role` (exposed by `/admin/login` and `GET /admin/me`) from the database on each request; the role is never in the token. Deactivation and `POST /admin/admins/:id/revoke-sessions` move the target's watermark. See `docs/ADMIN.md`.
- `GET /admin/me` is the server-side route guard. Every protected admin page waits for it before rendering, and any 401 sends the browser to `/admin/login`.
- `POST /leads` (sign-in optional) attaches a lead to an account only when the token passes the same liveness check as `requireAuth`.

### Widget
Unchanged: no cookies. It does not use the dashboard's API client.

## Migration / deploy notes
- Run `db/migrations/20261114_revocable_sessions.sql` before deploying the API. It is idempotent and wired into `db/schema.sql`.
- The migration does **not** sign dashboard users out. Their `tokens_valid_after` stays null and every existing refresh token gets a `session_id`, so it keeps working. Pre-deploy access tokens have no `sid`, so `requireAuth` rejects them, and the updated dashboard renews silently on that first 401. A dashboard build without the refresh-on-401 change would send users to `/login` once, at the 401.
- The migration also sets `admin_users.tokens_valid_after = now()` once, which kills the old admin UI's sessionStorage bearer tokens. Admins must sign in again after deploy.
- **Deploy order:**
  1. Run the migration.
  2. Deploy the API. Replace every instance; do not run old and new instances side by side for long. Old instances issue 7-day tokens without a `sid`, which new instances reject, so a user who hits an old instance just refreshes against a new one.
  3. Deploy the frontend. The new admin UI needs the cookie API. The new dashboard is backward compatible with the old API.
- Clock note: token issue time and watermarks both come from the database clock. Only the JWT `exp` uses the app clock, as before.
- If a deployment sets `ACCESS_TOKEN_TTL_SECONDS` explicitly (the old `.env.example` had `604800`), lower it to `900`.
