# Railway Deploy Runbook

## Scope
Use Railway for API and worker surfaces.

## Suggested commands
- Build: `npm run build:api`
- Start: `npm run start:api`
- Pre-deploy migration: `npm run migrate:api`

## Required env vars
- `DATABASE_URL`
- `REDIS_URL`
- `WEB_APP_BASE_URL`
- `NEXT_PUBLIC_API_BASE_URL`
- `PUBLIC_ASSET_BASE_URL`
- `ASSET_SIGNING_SECRET`
- `PARENT_AUTH_SECRET`

## Post-deploy checks
- `GET /health` returns success.
- Smoke flow passes against deployed API.
