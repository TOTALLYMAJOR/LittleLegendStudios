# Vercel Deploy Runbook

## Scope
Use Vercel for the web app in `apps/web`.

## Required env vars
- `NEXT_PUBLIC_API_BASE_URL`
- `WEB_APP_BASE_URL`

## Child-director preview defaults
- If `NEXT_PUBLIC_CHILD_DIRECTOR_ENABLED` is unset, Vercel preview builds default it to enabled.
- If `NEXT_PUBLIC_CHILD_DIRECTOR_RELEASE2_ENABLED` is unset, Vercel preview builds default it to enabled.
- Production still defaults both flags to disabled unless explicitly set.

## Pre-deploy checks
```bash
npm run typecheck
npm run build
```

## Post-deploy checks
- Landing page renders.
- Create flow can reach API using `NEXT_PUBLIC_API_BASE_URL`.
- `/create/child-director` renders on preview deployments unless explicitly disabled by env.
