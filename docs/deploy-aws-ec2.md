# Deploying ChatMate360 on AWS EC2

This runbook deploys the backend (API + crawl worker + ClamAV) to **one EC2
instance** using Docker Compose, with Caddy in front for HTTPS. The frontend
stays on Vercel. Postgres and Redis are managed services (Neon/RDS and
Upstash/ElastiCache), so the instance holds no data you can't rebuild.

Files used:

- `deploy/aws/docker-compose.prod.yml`: api, worker, clamav, caddy
- `deploy/aws/Caddyfile`: TLS + reverse proxy
- `db/schema.sql`: full idempotent schema (includes `rls.sql` and every migration)
- `docs/deploy-checklist-phase1-3.md`: the Phase 1-3 checks (backup, over-limit query, smoke tests). This runbook covers the AWS-specific steps and points back to that checklist where they overlap.

```
Browser ── Vercel (Next.js frontend)
   │
   └─ https://api.example.com ── EC2: Caddy :443 ─► api :4000 ─┬─► Postgres (Neon or RDS + pgvector)
                                            worker ─────────────┼─► Redis (Upstash or ElastiCache)
                                            clamav :3310 ◄──────┤
                                                                └─► S3 bucket (documents + attachments)
```

---

## 0. Decisions to make first

| Decision | Recommended | Why |
|---|---|---|
| Instance size | **t3.large** (2 vCPU, 8 GiB) | ClamAV alone needs ~3 GiB RAM, and Playwright crawls need headroom. t3.medium (4 GiB) will OOM-kill ClamAV under load. |
| OS | Ubuntu 24.04 LTS (x86_64) | The image is `mcr.microsoft.com/playwright:*-jammy` (amd64). Don't use a Graviton/arm64 instance without rebuilding for arm64. |
| Disk | 30 GiB gp3 | Two images: API ≈ 0.8 GiB (slim Node, no browsers) and worker ≈ 2.5 GiB (Playwright/Chromium), ClamAV signatures ≈ 1 GiB, plus build cache and logs (both capped/pruned, see step 4). |
| Postgres | Keep **Neon** (already in use), or RDS Postgres 16 | Both support `pgvector`. RDS: put it in the same VPC, not publicly reachable. |
| Redis | Keep **Upstash**, or ElastiCache | Upstash's free tier ran out once before; use a paid tier for production. |
| File storage | **S3** with an instance IAM role | `DOCUMENT_STORAGE_DRIVER=fs` is refused in production. |

## 1. Build a new instance (don't restart a compromised one)

**If the previous instance was attacked, never start it again on the public internet.** You can't prove an attacker didn't leave a backdoor (cron job, SSH key, systemd service, modified binary), so cleaning it isn't safe. Keep it stopped as evidence and build fresh.

### 1a. Preserve the old instance as evidence (5 minutes)

1. Leave it **stopped**. Don't start it.
2. EC2 → Volumes → its root volume → **Actions → Create snapshot** (name it `chatmate360-compromised-YYYYMMDD`).
3. Security group of the old instance: remove **all** inbound rules, so it stays unreachable even if someone starts it by mistake.
4. EC2 → Key pairs: delete the old key pair, and delete its `.pem` from your laptop (`chatmate-prod-key.pem` if that's the one). The new instance gets a new key.
5. If the old instance has an Elastic IP, **disassociate** it (keep it) so you can move it to the new instance.

Terminate the old instance and delete the snapshot only after the investigation in section 12 is finished.

### 1b. Rotate every secret the old instance could see

Assume everything in its `.env` and its database is known to the attacker. Rotate **before** the new instance goes live, or the attacker can use the old values against it:

| Secret | Where to rotate | Side effect |
|---|---|---|
| `JWT_SECRET` | generate new: `openssl rand -hex 32` | everyone is logged out once |
| Database passwords (`postgres`, `chatmate360_app`) | Neon/RDS console or `alter role ... password` | update `DATABASE_URL` |
| Redis password | Upstash console → reset password | update `REDIS_URL` |
| `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY` | each provider's console: revoke old, create new | check provider bills for usage you don't recognise |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Stripe → Developers → API keys (roll), Webhooks (new endpoint secret) | |
| `RESEND_API_KEY` | Resend → API keys | |
| `GOOGLE_CLIENT_SECRET` | Google Cloud → Credentials → reset secret | |
| Any AWS access keys that were on the box | IAM → user → Security credentials → deactivate + delete | the new setup uses an instance role instead |
| GitHub deploy key on the box | GitHub → repo → Settings → Deploy keys → delete | |
| `INTEGRATION_ENCRYPTION_KEY` | **don't change it blindly**: stored WooCommerce/Bookly/custom-action credentials are encrypted with it. If the database was also on the old box, ask those customers to regenerate their keys instead. | |

**If the database ran on the old instance** (the dev `docker-compose.yml` with password `postgres`), treat user data as exposed: emails, password hashes, chat transcripts. Force a password reset for all users, and check your legal obligations for notifying them (e.g. GDPR's 72-hour rule if you have EU users).

### 1c. Launch the new instance

EC2 → Launch instance:

- **AMI:** Ubuntu Server 24.04 LTS (x86_64). **Type:** t3.large. **Storage:** 30 GiB gp3, encrypted.
- **Key pair:** create a new ed25519 key pair; save the `.pem` somewhere private, not inside a repo.
- **Network:** a *new* security group (section 2). Don't reuse the old one.
- **Advanced → IAM instance profile:** the role from section 2. **Metadata version:** IMDSv2 only (required).
- Associate the Elastic IP (or allocate a new one).

Then SSH in and update:

```sh
chmod 600 chatmate360-new.pem
ssh -i chatmate360-new.pem ubuntu@<elastic-ip>
sudo apt update && sudo apt -y upgrade && sudo reboot
```

### 1d. Basic hardening on first login

```sh
# Automatic security updates
sudo apt -y install unattended-upgrades && sudo dpkg-reconfigure -plow unattended-upgrades

# SSH: keys only, no root login
sudo sed -i -E 's/^#?PasswordAuthentication .*/PasswordAuthentication no/; s/^#?PermitRootLogin .*/PermitRootLogin no/' /etc/ssh/sshd_config
sudo systemctl restart ssh

# Ban repeated SSH login failures
sudo apt -y install fail2ban
```

The real firewall is the **AWS security group**, because Docker-published ports bypass `ufw`. Only Caddy publishes ports (80/443) in `deploy/aws/docker-compose.prod.yml`. **Never run the repo's root `docker-compose.yml` on a server:** it is for local development, with password `postgres` and a Redis without a password.

## 2. Security group, IAM role, S3 bucket

**Security group (inbound):**

| Port | Source | Purpose |
|---|---|---|
| 22 | Your IP only (`x.x.x.x/32`) | SSH. Or close it and use SSM Session Manager. |
| 80 | 0.0.0.0/0 | Caddy's Let's Encrypt challenge + redirect to HTTPS |
| 443 | 0.0.0.0/0 | API |

Do **not** open 4000, 3310, 5432 or 6379. The API and ClamAV are only reachable inside the Docker network.

**S3 bucket:** create e.g. `chatmate360-prod-files` in the instance's region. Keep **Block all public access** on and enable default encryption (SSE-S3). The app streams downloads itself, so the bucket never needs to be public.

**IAM role:** create a role for EC2 with this policy and attach it to the instance (Actions → Security → Modify IAM role). Using a role means no access keys to store or rotate. The backend's S3 client (`src/lib/objectStorage.ts`) falls back to the instance role when `DOCUMENT_STORAGE_ACCESS_KEY` is empty.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
      "Resource": "arn:aws:s3:::chatmate360-prod-files/*"
    },
    {
      "Effect": "Allow",
      "Action": ["s3:ListBucket"],
      "Resource": "arn:aws:s3:::chatmate360-prod-files"
    }
  ]
}
```

Also attach `AmazonSSMManagedInstanceCore` if you want Session Manager access instead of SSH.

## 3. DNS

Create an **A record** `api.yourdomain.com → <elastic-ip>`. Wait until `dig +short api.yourdomain.com` returns the Elastic IP *before* starting Caddy, or the certificate request fails and Let's Encrypt rate-limits you.

## 4. Install Docker and get the code

```sh
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker ubuntu && newgrp docker
docker compose version   # must be v2.x

# Swap: a safety net so a memory spike slows things down instead of OOM-killing ClamAV.
sudo fallocate -l 4G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

# Disk housekeeping, so the 30 GiB volume doesn't slowly fill up:
# 1. Default log rotation for every container (the compose file also sets it per service).
echo '{"log-driver":"json-file","log-opts":{"max-size":"10m","max-file":"3"}}' | sudo tee /etc/docker/daemon.json
sudo systemctl restart docker
# 2. Cap the systemd journal.
sudo sed -i 's/^#\?SystemMaxUse=.*/SystemMaxUse=200M/' /etc/systemd/journald.conf && sudo systemctl restart systemd-journald
# 3. Weekly cleanup of old images (each rebuild leaves the old ones behind, ~3 GiB) and build cache.
#    Running containers and named volumes (ClamAV signatures, Caddy certificates) are never touched.
echo '0 4 * * 0 root docker image prune -af --filter "until=168h" && docker builder prune -af --filter "until=168h"' | sudo tee /etc/cron.d/docker-cleanup

# Code. The repo is private: use a read-only deploy key (GitHub → repo → Settings → Deploy keys).
ssh-keygen -t ed25519 -f ~/.ssh/chatmate360_deploy -N ""
cat ~/.ssh/chatmate360_deploy.pub     # add this as a read-only deploy key on GitHub
cat >> ~/.ssh/config <<'EOF'
Host github.com
  IdentityFile ~/.ssh/chatmate360_deploy
EOF
git clone git@github.com:TheSolutionsTag/Chatmate360-Backend.git ~/chatmate360-backend
cd ~/chatmate360-backend
```

If the clone says *Repository not found*, the repo name or access has changed. Check the exact name under the TheSolutionsTag org on GitHub first.

## 5. Production environment file

Create `~/chatmate360-backend/.env.production` (never commit it; `chmod 600` it). Start from `.env.example` and set at least:

```sh
NODE_ENV=production
API_DOMAIN=api.yourdomain.com             # used by Caddy
FRONTEND_URL=https://<your-vercel-domain> # exact origin, no trailing slash: this is the CORS allow-list
TRUST_PROXY_HOPS=1                        # Caddy is one proxy hop

DATABASE_URL=postgresql://chatmate360_app:<strong-password>@<host>/<db>?sslmode=require
SYSTEM_DATABASE_URL=postgresql://chatmate360_system:<different-strong-password>@<host>/<db>?sslmode=require
RLS_ENABLED=true
RLS_APP_ROLE=chatmate360_app
REDIS_URL=rediss://default:<password>@<host>:6379

JWT_SECRET=<openssl rand -hex 32>
INTEGRATION_ENCRYPTION_KEY=<keep the existing production value; changing it makes stored integration credentials unreadable>

OPENAI_API_KEY=...
ANTHROPIC_API_KEY=...
GEMINI_API_KEY=...

RESEND_API_KEY=re_...                     # REQUIRED for team invites; see below
EMAIL_FROM=ChatMate360 <noreply@yourdomain.com>

DOCUMENT_STORAGE_DRIVER=s3
DOCUMENT_STORAGE_BUCKET=chatmate360-prod-files
DOCUMENT_STORAGE_REGION=<instance region, e.g. eu-west-2>
DOCUMENT_STORAGE_ENDPOINT=                # empty for real AWS S3
DOCUMENT_STORAGE_ACCESS_KEY=              # empty: uses the instance IAM role
DOCUMENT_STORAGE_SECRET_KEY=

DOCUMENT_SCAN_VENDOR=clamav               # host/port are set by the compose file
ALLOW_UNSAFE_PROD_DEFAULTS=               # leave unset

STRIPE_SECRET_KEY=...  STRIPE_WEBHOOK_SECRET=...  STRIPE_PRICE_CRAWL_PLUS=...  STRIPE_PRICE_FULL_CUSTOM=...
GOOGLE_CLIENT_ID=...   GOOGLE_CLIENT_SECRET=...   GOOGLE_REDIRECT_URI=https://api.yourdomain.com/auth/google/callback
SENTRY_DSN=...                            # optional but recommended
```

Values that commonly break members/attachments in production:

- **`RESEND_API_KEY` empty:** invites are created but **no email is sent**. The invite link (a live token) and password-reset links are written to the logs instead. Members appear "not working". Set it, and verify the sending domain in Resend (SPF/DKIM), or Resend rejects mail from `EMAIL_FROM`.
- **`FRONTEND_URL` wrong:** invite links point at the wrong site, and the browser blocks every dashboard call with CORS errors.
- **`DOCUMENT_SCAN_VENDOR` / `DOCUMENT_STORAGE_DRIVER` left at dev values:** the API refuses to boot (`assertProductionGuards`).
- **The owner is on the Free plan:** Free has 1 seat and no attachments. That's by design, not a bug.

## 6. Database: back up, then migrate

Follow **sections 1.1-1.2 of `docs/deploy-checklist-phase1-3.md`** first (pg_dump with a version check, verify the dump isn't empty, run the over-limit query). Dry-run on a Neon branch or an RDS snapshot restore before touching production.

Then apply the schema from the instance using a throwaway Postgres client container (no local psql needed). Use the **owner/admin** connection string here, not `chatmate360_app`:

```sh
cd ~/chatmate360-backend
docker run --rm -v "$PWD/db:/db" postgres:16 \
  psql "$ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 --single-transaction -f /db/schema.sql
```

`schema.sql` is idempotent and includes every migration, including the three that members and attachments need (`20261026_crawl_plus_doc_limits`, `20261027_workspace_members`, `20261027_chat_attachments`). If they're missing, members/attachments routes return 500 ("relation does not exist"). The same thing caused the earlier `/auth/login` 500 on AWS.

Check they landed:

```sh
docker run --rm postgres:16 psql "$ADMIN_DATABASE_URL" -tAc \
  "select count(*) from information_schema.tables where table_schema='public'
     and table_name in ('workspace_members','workspace_invitations','chatbot_attachments','attachment_storage_usage')"
# expect 4
```

**Set the role passwords.** `db/rls.sql` and `20261115_rls_1_system_role.sql` create `chatmate360_app` (tenant) and `chatmate360_system` (admin/system work) **without a password** (CS-15), so neither can log in until you set one from your secret store. Use two different values:

```sh
docker run --rm postgres:16 psql "$ADMIN_DATABASE_URL" -c "alter role chatmate360_app password '<strong-password>'"
docker run --rm postgres:16 psql "$ADMIN_DATABASE_URL" -c "alter role chatmate360_system password '<different-strong-password>'"
```

and use them in `DATABASE_URL` / `SYSTEM_DATABASE_URL` (API **and** worker). The `schema.sql` run above is safe on a live database: it does **not** apply the RLS lockdown, which is its own step after the stack is up (section 7, "Apply the RLS lockdown"; `docs/RLS.md` "Two-role rollout"). In production the API and worker refuse to start when `SYSTEM_DATABASE_URL` is missing or either URL uses a default/self-named password, and refuse a connection whose role bypasses RLS (`rls.bypass_role`) or whose tenant role is a member of `chatmate360_system`.

## 7. Start the stack

```sh
cd ~/chatmate360-backend
docker compose -f deploy/aws/docker-compose.prod.yml --env-file .env.production up -d --build
docker compose -f deploy/aws/docker-compose.prod.yml ps
```

First start takes several minutes: ClamAV downloads its signature database before reporting healthy, and the API/worker wait for it. Follow progress with:

```sh
docker compose -f deploy/aws/docker-compose.prod.yml logs -f clamav api worker
```

Expected: `chatmate360 backend listening`, `redis reachable at boot`, worker started, **no** `rls.bypass_role` warning, and `curl https://api.yourdomain.com/health` → `{"ok":true,...}`.

**Apply the RLS lockdown (CS-15 step 3) only now**, after the API and worker above are healthy with `SYSTEM_DATABASE_URL` set. Until then they log `rls.lockdown_missing`:

```sh
docker run --rm -v "$PWD/db:/db" postgres:16 \
  psql "$ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 -f /db/migrations/20261115_rls_2_lockdown.sql
docker run --rm postgres:16 psql "$ADMIN_DATABASE_URL" -tAc "select app.cs15_lockdown_applied()"   # expect t
```

Then repeat the health check and an admin login. Never run this file before the CS-15 code is serving traffic.

The containers have `restart: unless-stopped` and Docker starts on boot, so the stack comes back by itself after a reboot or a stop/start.

## 8. Frontend (Vercel)

In the Vercel project → Settings → Environment Variables (Production):

```
NEXT_PUBLIC_API_URL=https://api.yourdomain.com     # no trailing slash
NEXT_PUBLIC_SITE_URL=https://<your-vercel-domain>
```

`NEXT_PUBLIC_*` values are baked in at build time, so **redeploy** after changing them. Embed snippets for customer sites must also use the new API domain for `embed.js`.

Then point the webhooks at the new domain: Stripe → `https://api.yourdomain.com/webhooks/stripe`, WooCommerce stores → `/webhooks/woocommerce/<chatbotId>`, Calendly → `/webhooks/calendly`. Update the Google OAuth redirect URI in Google Cloud Console to match `GOOGLE_REDIRECT_URI`.

## 9. Smoke tests

Run section 3 of `docs/deploy-checklist-phase1-3.md` against production. At minimum:

**Members** (as a Crawl Plus or Full Custom owner):
1. Team page shows `1 of 4 seats used` (Crawl Plus).
2. Invite an address you control → the email **arrives** → accept it while signed in as that new account.
3. As the Viewer: Billing is hidden; creating a chatbot is refused; the owner's chatbots are visible.
4. Seat count includes pending invites; at the limit the invite button is disabled.

**Attachments:**
1. On a site matching the chatbot's allowed domain, the widget shows the paperclip.
2. Upload a small PNG → the bot replies with the "team will review it" acknowledgement.
3. Dashboard → Attachments lists it; Download returns the same file.
4. Ask "what's in my file?" → the bot does not claim to have read it.
5. Upload the EICAR test string as a `.txt` → rejected/quarantined (proves ClamAV is wired up, not mock).

## 10. Updating later

```sh
cd ~/chatmate360-backend
git pull
# If the pull added files under db/migrations: back up, then re-run step 6's schema.sql command.
docker compose -f deploy/aws/docker-compose.prod.yml --env-file .env.production up -d --build api worker
# Remove the previous images and their build cache right away (~3 GiB per rebuild).
docker image prune -f && docker builder prune -f
```

Check disk and memory at any time with `df -h /`, `docker system df` and `docker stats --no-stream`. Each service has a hard memory limit in the compose file (API 1 GiB, worker 2 GiB, ClamAV 3.5 GiB, Caddy 256 MiB). If `docker stats` shows one sitting near its limit, raise that limit rather than removing it.

Migrations go **before** the new code, the same as on Railway.

## 11. Operations

- **Logs:** `docker compose -f deploy/aws/docker-compose.prod.yml logs --since 1h api`. Logs rotate at 5 × 20 MB per container.
- **Backups:** Neon has point-in-time restore; for RDS turn on automated backups (7+ days). The EC2 disk holds nothing that can't be rebuilt except `.env.production`, so keep a copy of it in a password manager or AWS Secrets Manager.
- **Monitoring:** a CloudWatch alarm on instance status checks and CPU, an uptime check on `/health`, and Sentry for app errors.
- **Cost:** t3.large on-demand is about $60/month in most regions (a 1-year Savings Plan cuts ~30-40%), plus the Elastic IP (~$3.60/month), EBS (~$2.40/month for 30 GiB), and S3 usage. Stopping the instance stops compute billing but not EBS or the Elastic IP.
- **Scaling later:** split the worker onto its own instance (same image, `worker:start`) when crawls start competing with chat latency, and put an ALB in front of 2+ API instances. Rate limiting and usage reservations already live in Redis/Postgres, so multiple API instances are safe.

## 12. Finding out what happened to the old instance

Do this from the **snapshot** taken in step 1a, never by starting the old instance on the internet.

**From the AWS console first (no instance needed):**

- **Security group of the old instance:** list its inbound rules. Any `0.0.0.0/0` rule on 5432/5435/6379/6432/3310/4000/22 is a likely entry point.
- **Billing → Cost Explorer:** a spike in EC2 or data-transfer cost points to crypto-mining or the box being used to attack others.
- **CloudTrail → Event history:** look for API calls you didn't make (new IAM users/keys, new instances in other regions, changed security groups). If any appear, an AWS key leaked, which is more serious than one instance.
- **Abuse e-mails from AWS** in the account's inbox: they usually name the activity (port scanning, mining, spam).

**Then inspect the disk safely:** launch a throwaway instance with **no inbound rules**, create a volume from the snapshot, attach it as a second disk, and mount it **read-only**:

```sh
sudo mkdir /mnt/old && sudo mount -o ro,noexec /dev/nvme1n1p1 /mnt/old   # check the device name with lsblk
```

Look for:

```sh
# Unknown SSH keys (attackers add their own)
sudo cat /mnt/old/root/.ssh/authorized_keys /mnt/old/home/*/.ssh/authorized_keys
# Persistence: cron jobs and systemd services you didn't create
sudo ls -la /mnt/old/etc/cron.* /mnt/old/var/spool/cron/crontabs/ 2>/dev/null
sudo ls -lt /mnt/old/etc/systemd/system/ | head -20
# Miner / dropper files usually land in temp dirs
sudo ls -la /mnt/old/tmp /mnt/old/var/tmp /mnt/old/dev/shm
# Logins and SSH attempts
sudo grep -E "Accepted|Failed password" /mnt/old/var/log/auth.log* | tail -50
# Which Docker containers and ports were running
sudo ls /mnt/old/var/lib/docker/containers/
sudo grep -h '"HostPort"' /mnt/old/var/lib/docker/containers/*/hostconfig.json
```

Typical findings for this kind of setup:

| Finding | Meaning |
|---|---|
| Redis or Postgres published on `0.0.0.0` | Unauthenticated Redis or `postgres:postgres` reachable from the internet. The most common way these boxes get taken over, usually followed by a crypto-miner. |
| Processes/files named like `kdevtmpfsi`, `kinsing`, `xmrig`, random names in `/tmp` | Crypto-miner |
| Unknown key in `authorized_keys`, or a new cron line with `curl ... \| sh` | Persistence: the attacker planned to come back |
| `.env` file readable and an outbound connection in logs | Assume all secrets leaked (step 1b) |

When done: unmount, delete the throwaway instance and volume, keep the snapshot for ~30 days, then delete it and terminate the old instance.
