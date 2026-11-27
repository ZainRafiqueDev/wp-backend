# Two build targets from one Dockerfile:
#
#   api   Slim Node image (~0.5 GB). The API never launches a browser:
#         crawling (src/lib/crawler/renderPage.ts) runs only in the worker
#         (src/worker.ts), so it doesn't need Playwright's ~2 GB of browsers.
#         Used by deploy/aws/docker-compose.prod.yml for the api service.
#
#   full  (default, last stage) Playwright image with Chromium + OS deps.
#         Required by the crawl worker; also what a plain `docker build .`
#         produces, so any platform building without --target behaves exactly
#         as before. Base image tag MUST match the installed `playwright`
#         package version in package.json (currently 1.62.1): a mismatch
#         between the library and the preinstalled browser build is a common,
#         confusing failure mode.
#
# Both stages:
#   - npm ci --omit=dev keeps vitest/supertest/typescript out of the image
#     (tsx, the runtime interpreter, is a regular dependency for this reason),
#     and clearing npm's cache in the same layer keeps ~100+ MB of tarballs out.
#   - --ignore-scripts: no dependency install script runs while the image is
#     built. The few packages that have one (scripts/security/
#     install-scripts-allowlist.json) work without it; CI boots the API from
#     an --ignore-scripts install to prove it.
#   - tsx is loaded into node itself (--import tsx) rather than via
#     `npm run start`, which kept three processes resident per container (npm,
#     the tsx CLI, node) and put npm between Docker's SIGTERM and the app's
#     own graceful-shutdown handler.

FROM node:24-bookworm-slim AS api

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY . .

# Runs unprivileged: the API only writes to /tmp (OCR scratch files).
USER node
CMD ["node", "--import", "tsx", "src/index.ts"]


FROM mcr.microsoft.com/playwright:v1.62.1-jammy AS full

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY . .

ENV NODE_ENV=production

# Audit 2026-11-27: the worker parses untrusted uploads (PDF/DOCX/XLSX/OCR)
# and drives Chromium against arbitrary websites, so it must not run as root.
# pwuser is the unprivileged user the Playwright image ships with. It only
# needs to write to /tmp (OCR scratch); documents go to S3 in production.
USER pwuser

CMD ["node", "--import", "tsx", "src/index.ts"]
