# Local Development Runbook

## Boot
```bash
npm run dev:boot
```

## Core checks
```bash
npm run typecheck
npm run build
bash ./scripts/smoke-local.sh
```

## Notes
- Default web: `http://localhost:3000`
- Default api: `http://localhost:4000`
- Use `SKIP_INFRA=1` if local Postgres and Redis are already running.
