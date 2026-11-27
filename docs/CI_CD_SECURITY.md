# CI/CD security (CS-14)

Applies to both repositories: `TheSolutionsTag/Chatmate360-Backend` and
`TheSolutionsTag/Chatmate360` (frontend). An identical copy of this file lives in
both repos at `docs/CI_CD_SECURITY.md`; change both together. Audit findings covered: S2-001, S2-002,
S1-006, S2-003, S2-004, S2-005, S2-012, S2-013, and the S1-002/S1-003/S1-005/B02-001
residue.

## PREREQUISITES — do these BEFORE merging the CS-14 workflows

The new workflows deploy (frontend → Vercel production) and publish (backend →
GHCR `:latest`) on **every push to `main`**. The old email gate is gone, so until
the settings below exist, anyone who can push to `main` can ship to production.
Merge the CS-14 workflow changes only after all of these are in place:

1. **Branch protection / ruleset on `main` in both repos**: pull request required,
   at least 1 approving review, required status checks, signed commits, force
   push and deletion blocked, no bypass (details in the checklist below).
2. **Frontend environment `production`**: required reviewers = the owner(s);
   deployment branches and tags = **`main` only**; `VERCEL_TOKEN` and
   `VERCEL_ORG_ID` stored **only** as environment secrets of `production`.
   Delete any repository-level (Settings → Secrets and variables → Actions)
   copies — a repo-level secret is readable by every job and every workflow,
   including ones that do not pass the environment's protection rules.
3. **CODEOWNERS enforcement**: "Require review from Code Owners" turned on in the
   `main` rule, and the placeholder owner in `.github/CODEOWNERS` replaced with a
   real user or team (see below). Without that setting CODEOWNERS only *requests*
   reviews; it does not block a merge.
4. **Rotate `VERCEL_TOKEN`** and put the new one straight into the `production`
   environment.

## What changed in the repositories

- **No user-controlled values inside `run:`.** The frontend gate that put
  `github.event.head_commit.author.email` straight into bash (script injection that
  could reach `VERCEL_TOKEN`) is gone. Event values that a step needs (the gitleaks
  commit range) are passed through `env:` and used as quoted `"$VAR"`. Secrets are
  passed through `env:` too (`--token="$VERCEL_TOKEN"`), never interpolated into the
  script text.
- **The author-email "ALLOWED_EMAILS" gate is removed.** The author email is whatever
  the committer typed into `git config`, so it never proved who made a commit, and it
  published personal email addresses. Its job is now done by GitHub settings the
  owner controls (checklist below): branch protection with required reviews and
  required checks, signed commits, and required reviewers on the `production`
  environment.
- **Least privilege.** Both workflows set top-level `permissions: contents: read`.
  Only the backend `publish` job gets `packages: write`. Checkouts use
  `persist-credentials: false`. The Vercel secrets are no longer workflow-level env
  (they were visible to the PR build job); they are given only to the steps that
  call `vercel pull` and `vercel deploy`.
- **Deploys only from `main` in the owner's repo.** Backend `publish` (GHCR push) and
  frontend `deploy-build` + `deploy-publish` (Vercel) run only when `event == push`, `ref == refs/heads/main`,
  `repository_owner == TheSolutionsTag` and the actor is not `dependabot[bot]`.
  Both frontend deploy jobs declare `environment: production`. Backend `build`
  (PRs and pushes) only checks that the image builds and has no write token;
  `publish` rebuilds and pushes.
- **Frontend deploy split so the token never meets repository code.**
  `deploy-build`: `vercel pull` (token, before any repo/dependency code runs) →
  `vercel build --prod` (**no token**; this is where install scripts and
  `next build` run) → the prebuilt `.vercel/output` + `.vercel/project.json` are
  tarred and uploaded (1-day retention; the pulled `.vercel/.env.*.local` files are
  not included). `deploy-publish`: fresh runner, no checkout and no project
  install, downloads the tarball with the preinstalled `gh` CLI (avoids another
  action) and runs `vercel deploy --prebuilt --prod` with the token.
  **Residual risk:** during `vercel build`, repository and dependency code can
  read the production environment variables that `vercel pull` wrote to `.vercel/`
  (the build needs them), and could tamper with the build output that
  `deploy-publish` then uploads. Both are limited to code that reached protected
  `main` through review, which is why the prerequisites above are mandatory.
  Not verifiable offline: that `vercel build` needs no token once `vercel pull`
  has run (it builds locally from `.vercel/`). If the first real run fails with an
  auth error in "Build for Vercel", that assumption is wrong — report it rather
  than moving the token back onto the build step.
  With required reviewers on `production`, GitHub asks for approval for each of
  the two jobs; use one environment with reviewers and accept two approvals, or
  move `deploy-build` to a second environment (e.g. `production-build`, branch =
  `main`, holding its own copy of the token) without reviewers.
- **Concurrency.** PR runs cancel older runs of the same PR. Runs on `main` are never
  cancelled half-way (that used to be able to cut a Vercel deploy or the
  `:sha`/`:latest` GHCR push).
- **Timeouts** on every job.
- **Vercel CLI pinned** to `vercel@65.8.0` (was `vercel@latest`). This is the version
  installed on the maintainer machine at the time of the change; bump it on purpose.
- **gitleaks without a licence.** `gitleaks/gitleaks-action@v2` needs a paid
  `GITLEAKS_LICENSE` on organisation repos (S2-005) and could fail the `security`
  job and therefore block `build`. The workflow now downloads the gitleaks CLI
  **8.30.1** and checks it against the SHA-256 from that release's
  `gitleaks_8.30.1_checksums.txt`
  (`551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb` for
  `linux_x64`). It scans only the commits the push/PR introduces, using
  `.gitleaks.toml`. To bump: change `GITLEAKS_VERSION` and `GITLEAKS_SHA256`
  together, taking the hash from the official checksums file of the new release.
- **Empty `codeql.yml` deleted** (it was 2 bytes, `\r\n`, so no CodeQL ever ran).
  Use CodeQL *default setup* instead (checklist), or add a SHA-pinned workflow later.
- **Dependabot** (both repos): weekly, all minor/patch bumps grouped into one PR,
  `open-pull-requests-limit` 3 (npm) / 2 (actions), `rebase-strategy: disabled`.
  Majors still get individual PRs. Security updates are not limited by these settings.
- **Integrity check** `scripts/security/check-autorun.mjs` (both repos, no
  dependencies) runs as the first CI job with plain `node`, before any install. It
  fails on: `.vscode/tasks.json` with `runOn: folderOpen`; `task.allowAutomaticTasks`
  enabled in `.vscode/settings.json` or a `*.code-workspace`; any tracked line over
  1,000 chars (lockfiles, `*.min.*`, `*.map`, `coverage/` and prose `.md/.txt` are
  exempt from the length rule only); 120+ spaces/tabs followed by code (no
  exemptions except lockfiles); package.json scripts whose `node`/`tsx`/... entry
  point is not a tracked file (e.g. `node init && ...`), that run inline code
  (`node -e`), or that pipe `curl`/`wget` into a shell; `eval(`, `new Function(`,
  `Function("...")` in `src/ app/ components/ lib/ pages/ hooks/`; and files under
  any `public/fonts/` that no other tracked file references. Run locally with
  `npm run security:check` (backend) / `pnpm security:check` (frontend); it also
  runs the self-test (`check-autorun.selftest.mjs`, fixtures are generated in a temp
  git repo). If a rule fires on something legitimate, fix the file (split the line,
  reference the asset, track the script) rather than widening the rule; if the rule
  itself must change, change it in a reviewed PR with a self-test case.
- **Malware residue removed:** `demos/booking-api/src/public/fonts/` (15 unreferenced
  Font Awesome files + a "Blockchain Explorer" README added by `cb6a8cf`). The
  SHA-256 of every removed file is in that removal commit's message.
- **`.gitattributes`** (`* text=auto eol=lf` + binary types) in both repos, so a
  CRLF rewrite can no longer hide a change inside a whole-file diff. Existing files
  were deliberately **not** renormalised (see follow-ups).

## Third-party actions: pinned to commit SHAs

Every `uses:` in both workflows is pinned to a full commit SHA, with the tag it
was resolved from in a comment. The SHAs were resolved read-only from the GitHub
API for the **same major tags** the workflows already used, so no major version
changed in CS-14:

| Action | Used in | Pin |
|---|---|---|
| `actions/checkout` | backend + frontend | `11d5960a326750d5838078e36cf38b85af677262 # v4` |
| `actions/setup-node` | backend + frontend | `49933ea5288caeca8642d1e84afbd3f7d6820020 # v4` |
| `actions/upload-artifact` | backend | `ea165f8d65b6e75b540449e92b4886f43607fa02 # v4` |
| `docker/login-action` | backend (`publish`) | `c94ce9fb468520275223c153574b00df6fe4bcc9 # v3` |
| `pnpm/action-setup` | frontend | `b906affcce14559ad1aafd4ab0e942779e9f58b1 # v4` |

Newer majors exist (checkout v7, setup-node v7, upload-artifact v7,
login-action v4, pnpm/action-setup v6). Upgrade them later through the
Dependabot github-actions PRs, one reviewed PR each, checking the release notes
for breaking changes. Never replace a pin with a moving tag. To check a pin:
`git ls-remote --tags https://github.com/<owner>/<action>` (for annotated tags
use the peeled `^{}` line), or run `pinact run --check` / `zizmor`.

## Owner checklist (GitHub / Vercel settings, not in code)

Do these for **both** repositories unless noted.

### Branch protection / ruleset on `main`
- [ ] Default branch is `main`.
- [ ] Require a pull request before merging; at least **1 approving review**; dismiss
      stale approvals on new commits; require review from someone other than the
      last pusher.
- [ ] Require status checks to pass, and require branches to be up to date:
      - backend: `Repository integrity (auto-run / hidden payload check)`,
        `Typecheck & test`, `Dependency audit & secret scan`, `Docker build`
      - frontend: `Repository integrity (auto-run / hidden payload check)`, `Build`
- [ ] **Require signed commits** (each contributor registers a GPG/SSH signing key).
- [ ] Block force pushes and branch deletion on `main` (this is what let the
      malware commits replace `main`, S1-005).
- [ ] Do not allow bypass, including for administrators (or keep bypass to one
      named break-glass account).
- [ ] Apply a similar ruleset to all branches (`*`) at least for "block force push",
      or restrict who can create branches.

### Environments
- [ ] Frontend: create environment **`production`**; required reviewers = the
      owner(s); deployment branches = `main` only; `VERCEL_TOKEN` and
      `VERCEL_ORG_ID` as **environment secrets only**, never repository-level
      Actions secrets (delete any repo-level copies).
- [ ] Backend (optional, once a host is chosen): same for the publish/deploy job.

### CODEOWNERS
- [ ] `.github/CODEOWNERS` (both repos) assigns `.github/`, `scripts/security/`,
      `.gitleaks.toml`, `.gitattributes`, `docs/CI_CD_SECURITY.md` (and, in the
      frontend, `vercel.json` and `scripts/vercel-allowed-deploy.sh`) to the
      placeholder `@TheSolutionsTag`. An organisation name is not a valid code
      owner: replace it with a real user (`@login`) or team
      (`@TheSolutionsTag/<team>`) that has write access.
- [ ] Turn on **"Require review from Code Owners"** in the `main` branch rule /
      ruleset. CODEOWNERS has no blocking effect without it.

### Actions settings (Settings → Actions → General)
- [ ] Workflow permissions: **Read repository contents** (read-only default
      `GITHUB_TOKEN`); untick "Allow GitHub Actions to create and approve pull
      requests".
- [ ] Fork pull request workflows: require approval for **all outside
      collaborators**.
- [ ] Allowed actions: GitHub-owned + selected (`docker/login-action`,
      `pnpm/action-setup`), with "require actions to be pinned to a full-length
      commit SHA" turned on (the workflows already comply).

### Secrets
- [ ] Rotate `VERCEL_TOKEN` (it was reachable through the S2-001 injection and on
      machines affected by S1-002); create the new one scoped to this project/team only.
- [ ] Rotate `INTEGRATION_ENCRYPTION_KEY` (CI dummy) only if desired; add it as a
      **Dependabot secret** too (Settings → Secrets → Dependabot), otherwise
      Dependabot PRs cannot run the encryption tests and always fail.
- [ ] Remove `GITLEAKS_LICENSE` if one was ever added (no longer used).
- [ ] Enable **secret scanning** and **push protection**.

### Code scanning and Dependabot
- [ ] Enable **CodeQL default setup** (Settings → Code security) for
      JavaScript/TypeScript and GitHub Actions. This replaces the empty
      `codeql.yml` that was deleted.
- [ ] Enable Dependabot alerts and security updates.
- [ ] Close the stale Dependabot branches/PRs from before this change; the new
      grouping will reopen what is still needed.

### Vercel
- [ ] Confirm in the Vercel dashboard that Git auto-deploy is really off for
      `chatmate360-wwdr` (vercel.json sets `git.deploymentEnabled: false`), so the
      only path to production is the protected `deploy-build` + `deploy-publish` jobs.
- [ ] Review the Vercel deployment list and GitHub Actions runs for 2026-10-28 to
      2026-11-09 for runs on unexpected commit SHAs (S1-006).

## Follow-ups (not done in CS-14)
- Upgrade the actions to their newer majors via Dependabot PRs (see above).
- One reviewed commit per repo running `git add --renormalize .` to convert files
  still stored with CRLF.
- Consider adding the gitleaks step and `pnpm audit --prod` to the frontend
  workflow, and `actionlint`/`zizmor` to both.
