# Railway Deploy Runbook

## Scope
Use Railway for API and worker surfaces.

## API service commands
- Build: `npm run build:api`
- Start: `npm run start:api`
- Pre-deploy migration: `npm run migrate:api`

## Worker service commands
- Build: `npm run build:worker`
- Start: `npm run start:worker`
- Pre-deploy migration: none

## Required env vars
- API service:
  - `DATABASE_URL`
  - `REDIS_URL`
  - `WEB_APP_BASE_URL`
  - `NEXT_PUBLIC_API_BASE_URL`
  - `PUBLIC_ASSET_BASE_URL`
  - `ASSET_SIGNING_SECRET`
  - `PARENT_AUTH_SECRET`
  - optional: `WORKER_HEARTBEAT_STALE_SEC` (default `90`)
- Worker service:
  - `DATABASE_URL`
  - `REDIS_URL`
  - `WEB_APP_BASE_URL`
  - `PUBLIC_ASSET_BASE_URL`
  - `ASSET_SIGNING_SECRET`
  - optional: `WORKER_HEARTBEAT_INTERVAL_MS` (default `15000`)
  - provider-mode + provider-secret envs for the active integration mode

## Post-deploy checks
- `GET /health` returns success.
- `GET /health/worker` returns success (`ok: true`) after worker starts.
- Worker logs include `Worker listening on queue render-orders`.
- Smoke flow passes against deployed API.
