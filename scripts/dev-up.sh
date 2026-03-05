#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [ ! -f .env ]; then
  cp .env.example .env
  echo "[boot] Created .env from .env.example. Review secrets before sharing this environment."
fi

compose_cmd=()
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  compose_cmd=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  compose_cmd=(docker-compose)
fi

if [ "${SKIP_INFRA:-0}" != "1" ]; then
  if [ "${#compose_cmd[@]}" -eq 0 ]; then
    echo "[boot] Docker Compose is required unless SKIP_INFRA=1."
    exit 1
  fi

  echo "[boot] Starting Postgres + Redis (infra/docker-compose.yml)..."
  set +e
  infra_output="$("${compose_cmd[@]}" -f infra/docker-compose.yml up -d 2>&1)"
  infra_status=$?
  set -e

  if [ "$infra_status" -ne 0 ]; then
    if echo "$infra_output" | grep -qi "port is already allocated"; then
      echo "[boot] Port conflict detected while starting Docker infra."
      echo "[boot] Continuing, assuming Postgres/Redis are already running on this machine."
      echo "[boot] If migration fails, free ports 5432/6379 or run with SKIP_INFRA=1."
    else
      echo "$infra_output"
      exit "$infra_status"
    fi
  else
    echo "$infra_output"
  fi
else
  echo "[boot] SKIP_INFRA=1, skipping Docker infrastructure startup."
fi

if [ "${SKIP_INSTALL:-0}" != "1" ]; then
  echo "[boot] Installing/updating npm dependencies..."
  npm install
else
  echo "[boot] SKIP_INSTALL=1, skipping npm install."
fi

if [ "${SKIP_MIGRATE:-0}" != "1" ]; then
  echo "[boot] Running API database migration..."
  npm --workspace @little/api run migrate
else
  echo "[boot] SKIP_MIGRATE=1, skipping DB migration."
fi

echo "[boot] Launching all dev services..."
exec npm run dev
