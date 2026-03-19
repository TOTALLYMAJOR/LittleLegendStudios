#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

read_env_value() {
  local key="$1"
  local env_file="${2:-.env}"

  if [ ! -f "$env_file" ]; then
    return 1
  fi

  local raw
  raw="$(grep -E "^${key}=" "$env_file" | tail -n 1 || true)"

  if [ -z "$raw" ]; then
    return 1
  fi

  local value="${raw#*=}"
  value="${value%$'\r'}"

  if [[ "$value" == \"*\" && "$value" == *\" ]]; then
    value="${value:1:${#value}-2}"
  elif [[ "$value" == \'*\' && "$value" == *\' ]]; then
    value="${value:1:${#value}-2}"
  fi

  printf '%s' "$value"
}

resolve_env_value() {
  local key="$1"
  local existing="${!key:-}"

  if [ -n "$existing" ]; then
    printf '%s' "$existing"
    return 0
  fi

  read_env_value "$key" ".env" || true
}

parse_url_host_port() {
  local raw_url="$1"
  local fallback_port="$2"

  node -e '
const rawUrl = process.argv[1] ?? "";
const fallbackPort = process.argv[2] ?? "";
let host = "127.0.0.1";
let port = fallbackPort;
try {
  if (rawUrl) {
    const parsed = new URL(rawUrl);
    host = parsed.hostname || host;
    port = parsed.port || fallbackPort;
  }
} catch (error) {}
process.stdout.write(`${host}\n${port}\n`);
' "$raw_url" "$fallback_port"
}

is_local_host() {
  local host="$1"
  case "$host" in
    localhost|127.0.0.1|::1)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

normalize_local_host() {
  local host="$1"
  if [ "$host" = "::1" ]; then
    printf '%s' "127.0.0.1"
    return
  fi

  printf '%s' "$host"
}

wait_for_tcp() {
  local host="$1"
  local port="$2"
  local label="$3"
  local timeout_sec="${4:-90}"
  local started_wait=0
  local deadline=$((SECONDS + timeout_sec))

  while [ "$SECONDS" -lt "$deadline" ]; do
    if (echo >"/dev/tcp/${host}/${port}") >/dev/null 2>&1; then
      echo "[boot] ${label} is reachable at ${host}:${port}."
      return 0
    fi

    if [ "$started_wait" -eq 0 ]; then
      echo "[boot] Waiting for ${label} at ${host}:${port}..."
      started_wait=1
    fi

    sleep 2
  done

  echo "[boot] ${label} did not become reachable at ${host}:${port} within ${timeout_sec}s."
  return 1
}

wait_for_local_infra() {
  local database_url
  local redis_url

  database_url="$(resolve_env_value DATABASE_URL)"
  redis_url="$(resolve_env_value REDIS_URL)"

  local db_parts=()
  mapfile -t db_parts < <(parse_url_host_port "$database_url" "5432")
  local db_host="${db_parts[0]:-127.0.0.1}"
  local db_port="${db_parts[1]:-5432}"

  if is_local_host "$db_host"; then
    db_host="$(normalize_local_host "$db_host")"
    wait_for_tcp "$db_host" "$db_port" "Postgres" "90" || {
      echo "[boot] Postgres is unavailable. Ensure Docker is running, then retry."
      exit 1
    }
  else
    echo "[boot] DATABASE_URL host is non-local (${db_host}); skipping local Postgres readiness probe."
  fi

  local redis_parts=()
  mapfile -t redis_parts < <(parse_url_host_port "$redis_url" "6379")
  local redis_host="${redis_parts[0]:-127.0.0.1}"
  local redis_port="${redis_parts[1]:-6379}"

  if is_local_host "$redis_host"; then
    redis_host="$(normalize_local_host "$redis_host")"
    wait_for_tcp "$redis_host" "$redis_port" "Redis" "60" || {
      echo "[boot] Redis is unavailable. Ensure Docker is running, then retry."
      exit 1
    }
  else
    echo "[boot] REDIS_URL host is non-local (${redis_host}); skipping local Redis readiness probe."
  fi
}

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
  infra_output="$("${compose_cmd[@]}" -f infra/docker-compose.yml up -d --remove-orphans 2>&1)"
  infra_status=$?
  set -e

  if [ "$infra_status" -ne 0 ]; then
    if echo "$infra_output" | grep -qi "port is already allocated"; then
      echo "[boot] Port conflict detected while starting Docker infra."
      echo "[boot] Continuing, assuming Postgres/Redis are already running on this machine."
      echo "[boot] If migration fails, free ports 5432/6379 or run with SKIP_INFRA=1."
    elif echo "$infra_output" | grep -qi "Cannot connect to the Docker daemon"; then
      echo "[boot] Docker daemon is not reachable."
      echo "[boot] Start Docker or run with SKIP_INFRA=1 if external Postgres/Redis are already running."
      exit "$infra_status"
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

wait_for_local_infra

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
