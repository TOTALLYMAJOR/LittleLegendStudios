# Vercel Deploy Runbook

## Scope
Use Vercel for the web app in `apps/web`.

## Required env vars
- `NEXT_PUBLIC_API_BASE_URL`
- `WEB_APP_BASE_URL`

## Pre-deploy checks
```bash
npm run typecheck
npm run build
```

## Post-deploy checks
- Landing page renders.
- Create flow can reach API using `NEXT_PUBLIC_API_BASE_URL`.
