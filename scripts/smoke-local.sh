#!/usr/bin/env bash
set -euo pipefail

API_BASE_URL="${SMOKE_API_BASE_URL:-http://localhost:4000}"
HEALTH_URL="${API_BASE_URL%/}/health"

for attempt in {1..60}; do
  if curl --silent --fail "$HEALTH_URL" >/dev/null; then
    break
  fi

  sleep 2
done

curl --silent --fail "$HEALTH_URL" >/dev/null
npm run smoke
