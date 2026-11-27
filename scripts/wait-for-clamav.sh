#!/usr/bin/env bash
# Optional local-dev convenience: blocks until docker-compose.yml's clamav
# service reports healthy (clamdcheck.sh passing), then exits 0. Not
# required for correctness — malwareScan.service.ts already fails closed
# per-request when clamd is unreachable — this just avoids a burst of
# 503s from the first couple of upload attempts while ClamAV's signature
# database is still loading after a fresh `docker compose up`.
#
# Usage: ./scripts/wait-for-clamav.sh && npm run dev
set -euo pipefail

CONTAINER="${1:-chatmate360-backend-main-clamav-1}"
TIMEOUT_SECONDS="${WAIT_FOR_CLAMAV_TIMEOUT_SECONDS:-360}"
elapsed=0

echo "Waiting for $CONTAINER to report healthy (timeout: ${TIMEOUT_SECONDS}s)..."

while true; do
  status="$(docker inspect --format='{{.State.Health.Status}}' "$CONTAINER" 2>/dev/null || echo "unknown")"
  if [ "$status" = "healthy" ]; then
    echo "$CONTAINER is healthy."
    exit 0
  fi
  if [ "$elapsed" -ge "$TIMEOUT_SECONDS" ]; then
    echo "Timed out after ${TIMEOUT_SECONDS}s waiting for $CONTAINER (last status: $status)." >&2
    exit 1
  fi
  sleep 5
  elapsed=$((elapsed + 5))
done
