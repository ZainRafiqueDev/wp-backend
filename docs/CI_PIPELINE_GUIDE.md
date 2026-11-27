# ChatMate360 CI/CD pipeline: what it checks and what you switch on

This guide is the same in both repositories (backend and frontend). It is
written for the owner, not for CI experts. Updated 2026-11-27.

## The idea in one paragraph

Nobody pushes straight to `main`. Every change goes in through a pull request
(PR). GitHub runs a set of automatic checks on that PR. If any check fails, the
PR cannot be merged. When a PR is merged into `main`, the same checks run
again, and only if all of them pass is the code deployed (frontend to Vercel)
or published as a Docker image (backend). If anything fails, GitHub opens an
issue assigned to you, and can also e-mail you. Production keeps running the
last good version.

## The checks, in the order they run

| # | Check (name shown on the PR) | What it catches | Blocks merge / deploy? |
|---|---|---|---|
| 1 | **Repository integrity** | Auto-run tasks (`.vscode` folderOpen tasks), hidden code pushed off-screen with spaces, very long lines, package scripts that run hidden or untracked files, `eval`/`new Function`, unreferenced "font" files. These are the October malware tricks. | Yes |
| 1 | (same job) **Malware patterns** | Known payload hosts (catbox, pastebin raw, transfer.sh, Discord/Telegram webhooks, ngrok, webhook.site...), links to raw public IPs, `postinstall`/`preinstall`/`prepare` scripts, obfuscated code (`_0x1a2b` names, long `\x` escapes, `fromCharCode` lists), big base64 blobs, code that decodes and then runs something, tool config files that start processes or make network calls, fake fonts/images (a `.woff2` that is really JavaScript), SVGs with scripts, invisible "Trojan Source" characters, tracked `.exe`/`.dll`/`.bat`/`.ps1` files. | Yes |
| 1 | (same job) **Lockfile integrity** | Dependencies that come from anywhere other than the official npm registry, missing sha512 hashes (a swapped package would go unnoticed), git/URL dependencies, `.npmrc` pointing at another registry, and any **new** dependency that wants to run an install script. | Yes |
| 2 | **Typecheck & test** (backend) / **Build** (frontend) | Code that doesn't compile, lint errors, failing tests (1,171 backend tests), a frontend that doesn't build, secrets in the browser bundle, failing security tests. Backend also starts the real API and checks `/health` answers, so "tests pass but the app won't start" is caught. | Yes |
| 3 | **Dependency audit & secret scan** | Known high/critical vulnerabilities in production dependencies (`npm audit` / `pnpm audit`), tampered packages (`npm audit signatures`, backend), and passwords/API keys in the new commits (gitleaks). | Yes |
| 4 | **Antivirus scan (ClamAV)** | Known viruses and malware in the code **and** in all installed dependencies (`node_modules`), with virus definitions updated on every run. | Yes |
| 5 | **Docker build & image scan** (backend) | The Docker images must build. Trivy then scans them: a CRITICAL vulnerability that has a fix, or a secret baked into the image, fails the build. HIGH ones are listed in the log. | Yes (critical) |
| 6 | **CodeQL** | GitHub's code analyser: injection, SSRF, path traversal, unsafe redirects, XSS and similar bugs in the code, plus unsafe GitHub workflow patterns. Also runs weekly. | Yes, once required (step B) |
| 7 | **Dependency review** (PRs only) | A PR that adds a package with a known high/critical vulnerability or a known-malicious package. Shows a trust score for each new package. | Yes, once required |
| 8 | **Deploy** (frontend) / **Publish** (backend), `main` only | Runs only when every check above passed. Frontend then loads the live site and checks it answers (needs `PRODUCTION_URL`, step F). | — |

Two more safety nets that are not checks:

- **No install scripts run in CI or in Docker.** Every install uses
  `--ignore-scripts`. This is how most npm malware runs, so it simply never
  gets the chance.
- **Optional pre-push hook on your computer.** Runs checks 1 and the secret
  scan before `git push` even sends anything to GitHub (step H).

## What happens when something fails

- The PR shows a red ❌ and the merge button is blocked (after step B).
- GitHub opens an issue titled `CI failed: <check> on <branch>`, labelled
  `ci-failure` and assigned to you. GitHub e-mails you about it. If the same
  check fails again, it adds a comment instead of a new issue. When the check
  passes again, the issue closes itself.
- On `main`, the deploy/publish step is skipped, so production stays on the
  last version that passed everything.
- If you set up the optional e-mail secrets (step G) you also get a direct
  e-mail.

## One-time setup on GitHub (do this for BOTH repositories)

Everything below is in the repository's **Settings** tab. You need to be an
admin of the repository (or of the TheSolutionsTag organisation).

### A. Add the files

Merge the PR (or copy the files) that adds the new workflows and scripts. Do
this first: the checks only appear in the lists below after they have run
once.

### B. Protect `main` (the most important step)

Settings → **Rules** → **Rulesets** → **New ruleset** → **New branch ruleset**.

1. Name: `protect main`. Enforcement status: **Active**.
2. Target branches → **Add target** → **Include default branch**.
3. Bypass list: leave **empty** if someone else can review your PRs. If you
   are the only developer, add **Repository admin** and set it to
   **"For pull requests only"**. That lets you merge your own PR after the
   checks pass, but nobody (including you) can push straight to `main`.
4. Tick:
   - **Restrict deletions**
   - **Block force pushes**
   - **Require a pull request before merging**
     - Required approvals: **1** (if you have a second person; with 0 the
       checks still block, but nobody else looks at the code)
     - **Dismiss stale pull request approvals when new commits are pushed**
     - **Require review from Code Owners** (changes to the pipeline, security
       scripts, lockfiles and Docker files then always need your approval)
     - **Require approval of the most recent reviewable push**
     - **Require conversation resolution before merging**
   - **Require status checks to pass**
     - **Require branches to be up to date before merging**
     - Add these checks (type the start of the name and pick it):
       - Backend: `Repository integrity (auto-run / hidden payload check)`,
         `Typecheck & test`, `Dependency audit & secret scan`,
         `Antivirus scan (ClamAV)`, `Docker build & image scan`,
         `CodeQL (javascript-typescript)`, `CodeQL (actions)`,
         `Dependency review`
       - Frontend: `Repository integrity (auto-run / hidden payload check)`,
         `Build`, `Dependency audit & secret scan`, `Antivirus scan (ClamAV)`,
         `CodeQL (javascript-typescript)`, `CodeQL (actions)`,
         `Dependency review`
   - **Require code scanning results** → add **CodeQL**, alerts: *Errors*,
     security alerts: *High or higher*.
   - Optional: **Require signed commits** (each developer has to set up commit
     signing first).
5. **Create**.

### C. Turn on GitHub's own security features

Settings → **Advanced Security** (on older screens: *Code security and
analysis*):

- **Dependency graph**: On.
- **Dependabot alerts**: On. **Dependabot security updates**: On.
- **Secret Protection / Secret scanning**: On, and **Push protection**: On.
  Push protection stops a push that contains a password or API key *before*
  it reaches GitHub.
- **Private vulnerability reporting**: On.
- **Code scanning**: leave **Default setup OFF**. The repository has its own
  `codeql.yml` ("advanced setup"); turning on default setup as well makes them
  conflict.

**wp-frontend and wp-backend (private) use Semgrep instead.** CodeQL and
Dependency review were removed from them on 2026-11-27 and replaced by `semgrep.yml` (free on
private repos). In step B require `Semgrep code scan` instead of the two
CodeQL checks and `Dependency review`, and skip "Require code scanning
results".

If the repositories are **private** and your plan does not include GitHub Code
Security, CodeQL and Dependency review cannot run (they fail with "not
supported"). Then delete `.github/workflows/codeql.yml` and
`.github/workflows/dependency-review.yml` and leave them out of step B. All
other checks still run.

### D. Lock down GitHub Actions

Settings → **Actions** → **General**:

- **Actions permissions**: *Allow `<owner>`, and select non-`<owner>`
  actions and reusable workflows*, tick **Allow actions created by GitHub**,
  and in the box add:
  `pnpm/action-setup@*, docker/login-action@*`
- **Require actions to be pinned to a full-length commit SHA**: On (every
  action in these files already is).
- **Fork pull request workflows from outside collaborators**: *Require
  approval for all external contributors*.
- **Workflow permissions**: **Read repository contents and packages
  permissions**, and **untick** *Allow GitHub Actions to create and approve
  pull requests*.

### E. Production environment (frontend; also used by backend publish later)

Settings → **Environments** → `production`:

- **Required reviewers**: add yourself. Every deploy then waits for your click
  in the Actions tab.
- **Deployment branches and tags**: *Selected branches* → `main`.
- Keep `VERCEL_TOKEN` and `VERCEL_ORG_ID` here as **environment secrets**,
  never as repository secrets.

### F. Variables

Settings → **Secrets and variables** → **Actions** → **Variables** tab:

- `PRODUCTION_URL` (frontend only), e.g. `https://chatmate360.com`. Turns on
  the after-deploy check of the live site.
- `ALERT_ASSIGNEE` (optional): the GitHub login that alert issues are
  assigned to. Defaults to `ZainRafiqueDev`.

### G. Optional: direct e-mail alerts

Issues assigned to you already e-mail you if GitHub notifications are on
(github.com → your avatar → **Settings** → **Notifications**: tick *Email*
for *Participating, @mentions and custom*, and under **System → Actions**
choose *Only notify for failed workflows* + *Email*).

For a separate e-mail on every failure, add these four **repository secrets**
(Secrets tab). With Gmail, create an *App password* first (Google account →
Security → 2-Step Verification → App passwords):

| Secret | Example |
|---|---|
| `SMTP_URL` | `smtps://smtp.gmail.com:465` |
| `SMTP_USER` | the Gmail address that sends |
| `SMTP_PASSWORD` | the 16-letter app password |
| `ALERT_EMAIL_TO` | where alerts go |

### H. Optional: check before pushing, on your computer

In each cloned repository, once:

```
git config core.hooksPath .githooks
```

From then on `git push` runs the malware, auto-run and lockfile checks first
(and gitleaks, if installed) and refuses to push if they fail.

### I. If the repositories are not under TheSolutionsTag

(wp-frontend and wp-backend are already set to `ZainRafiqueDev`.) The deploy
(frontend) and image publish (backend) jobs only run when the repository
owner is `TheSolutionsTag`, so a fork can never deploy. If the
repositories live under another owner, change `TheSolutionsTag` in the
`repository_owner ==` line of `.github/workflows/ci.yml` to that owner,
otherwise every check passes but nothing is deployed.

## When a check fails: what to do

Open the alert issue → click the run link → click the job with ❌ → click the
red step. Then:

- **Repository integrity / malware patterns / lockfile integrity / antivirus**:
  treat it as a possible attack until proven otherwise. Do not merge. Look at
  the file and line it names. If it is a genuine false positive, add an entry
  with a clear reason to `scripts/security/malware-allowlist.json` (malware
  patterns) or `scripts/security/install-scripts-allowlist.json` (a new
  package with an install script you have read and trust). Those files need
  your review because of CODEOWNERS.
- **Secret scan**: a password or key was committed. Rotate that key first
  (it is in git history now), then remove it from the code.
- **Dependency audit / dependency review / Trivy**: a dependency has a known
  vulnerability. Usually the fix is updating that package (Dependabot often
  opens the PR for you). If there is no fix yet and you have checked it can't
  be exploited here, Trivy findings can go in `.trivyignore` with a reason
  and a review-by date.
- **CodeQL**: the alert under Security → Code scanning explains the bug and
  how to fix it.
- **Typecheck / lint / test / build / smoke test**: the change breaks
  something that works today. Fix the code; never skip or delete the test.
- **Frontend post-deploy check**: the new version is live but not answering
  properly. Vercel → `chatmate360-wwdr` → **Deployments** → the previous one →
  **Instant Rollback**, then fix.

## What this cannot do

These checks catch known malware, known tricks and broken builds. They cannot
prove that new code is honest: someone could write plain, normal-looking code
that does something bad. That is why the review step (and CODEOWNERS on the
sensitive files) matters, and why nobody, including admins, should be able to
push straight to `main`.

## Changes made on 2026-11-27 (for the record)

- **zod upgraded from 3.25 to 4.6.7** (backend). This fixes
  GHSA-mrhx-c7xc-m3w5, so the time-boxed exception that made CI fail from
  28 Nov 2026 is gone and the audit now blocks on any high/critical advisory.
  Code changes: `z.record()` now takes the key type too, and
  `z.string().uuid()` became `z.string().guid()` (zod 4's `uuid()` is stricter
  and would reject IDs like `11111111-1111-1111-1111-111111111111` that zod 3
  accepted). Typecheck, lint and all 1,171 tests pass; the API boots. One
  visible difference: some validation messages read differently, for example
  "Required" is now "Invalid input: expected string, received undefined". The
  frontend shows these messages to users on form errors.
- New checks and workflows as listed above; `--ignore-scripts` everywhere;
  CODEOWNERS now names `@ZainRafiqueDev` instead of the placeholder.
