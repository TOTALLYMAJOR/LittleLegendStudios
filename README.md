# Little Legend Studios MVP Scaffold

Template-first MVP scaffold for personalized cinematic child story videos.

## New Session Context

If you are opening this repo in a new Codex 5.3 session, start with [TASKS.md](/home/totallymajor/projects/LittleLegendStudios/TASKS.md). Its `New Session Handoff` section is the explicit repo-state summary, key entrypoints list, and next-work ledger.

For architecture flow and child-director workflow context, use [docs/architecture/workflows.md](/home/totallymajor/projects/LittleLegendStudios/docs/architecture/workflows.md) and [docs/decisions/adr-003-preview-pipeline.md](/home/totallymajor/projects/LittleLegendStudios/docs/decisions/adr-003-preview-pipeline.md).

For ownership rules and anti-duplication policy across docs, use [docs/runbooks/docs-governance.md](/home/totallymajor/projects/LittleLegendStudios/docs/runbooks/docs-governance.md).

## Stack

- Canonical stack register (required maintenance target when new tech is introduced): [docs/runbooks/tech-stack.md](/home/totallymajor/projects/LittleLegendStudios/docs/runbooks/tech-stack.md)
- Web: Next.js (`apps/web`)
- API: Fastify + Postgres (`apps/api`)
- Worker: BullMQ + Redis (`apps/worker`)
- Shared domain: TypeScript package (`packages/shared`)
- Infra dev deps: Postgres + Redis (`infra/docker-compose.yml`)

## Quick Start

### One-command boot (recommended)

```bash
npm run dev:boot
```

This command will:
- create `.env` from `.env.example` if missing
- start Postgres + Redis via `infra/docker-compose.yml`
- run Docker startup with `--remove-orphans` to clear stale local infra containers
- wait for local Postgres + Redis readiness before running migration
- run `npm install`
- run API DB migration
- start all services (`shared`, `api`, `worker`, `web`)

Optional flags:
- `SKIP_INFRA=1 npm run dev:boot`
- `SKIP_INSTALL=1 npm run dev:boot`
- `SKIP_MIGRATE=1 npm run dev:boot`

If port `3000` is already in use, run the web app on another port:
- `WEB_PORT=3001 WEB_APP_BASE_URL=http://localhost:3001 npm run dev:boot`

If you already run local Postgres/Redis and Docker reports `port is already allocated`, use:
- `SKIP_INFRA=1 npm run dev:boot`

### Manual boot

1. Copy env values:

```bash
cp .env.example .env
```

2. Start local infra:

```bash
docker compose -f infra/docker-compose.yml up -d --remove-orphans
```

3. Install dependencies:

```bash
npm install
```

4. Run DB migration:

```bash
npm --workspace @little/api run migrate
```

5. Start all services:

```bash
npm run dev
```

If the web app needs a different port:

```bash
WEB_PORT=3001 WEB_APP_BASE_URL=http://localhost:3001 npm run dev
```

## Smoke Test

Run the end-to-end API smoke flow:

```bash
npm run smoke
```

What it validates:
- health check + theme fetch
- user/order creation + consent
- upload signing + binary uploads (5 photos, 1 voice)
- script generate + approve + pay (requires stub payment mode)
- async render completion polling
- parent-facing retry endpoint
- gift link create + redeem flow
- email notification rows persisted in `email_notifications`

Notes:
- Start API + worker first (`npm run dev:boot` in a separate terminal).
- If `STRIPE_SECRET_KEY` is set, `/pay` uses live checkout and smoke exits by design. Use stub mode for automation.

## VS Code Agent Autopilot

For low-intervention multi-agent orchestration (task dispatch, runbook generation, verification, PR automation), use the runbook:
- [docs/runbooks/agent-autopilot.md](/home/totallymajor/projects/LittleLegendStudios/docs/runbooks/agent-autopilot.md)

Common commands:
- `npm run agents:dry-run`
- `npm run agents:dispatch`
- `npm run agents:dispatch:batch`
- `npm run agents:resume`
- `npm run docs:check`
- set `AGENT_IMPLEMENTER_CMD=bash ./scripts/agents/implementer.sh` (repo variable for CI, env var for local)
- PR template + workflow gate (`pr-body-contract`) require `Docs impact` so documentation deltas are explicit.

## Vercel UI Preview

If the immediate goal is to let people see the UI while the full backend keeps evolving, deploy only the web app to Vercel first.

Recommended setup:
- import the GitHub repo into Vercel
- create a project for the Next.js app in `apps/web`
- set the Vercel project Root Directory to `apps/web`
- leave the monorepo root as-is in GitHub; Vercel will build the web app project from that subdirectory

Preview envs:
- `NEXT_PUBLIC_API_BASE_URL`
  - set this to a real public API URL if you want interactive flows to work
  - if you only want a UI preview, the landing page will still render without it, but create/admin actions that need the API will not work
- `NEXT_PUBLIC_CHILD_DIRECTOR_ENABLED`
  - set to `true` to expose the experimental `/create/child-director` Explorer-mode story-lane prototype
  - when unset on Vercel preview deployments, the route now defaults to enabled so branch previews include the child-interactive surface
  - keep `false` in production until child-directed slices are validated
- `NEXT_PUBLIC_CHILD_DIRECTOR_RELEASE2_ENABLED`
  - set to `true` to enable release-2 pilot controls inside the child-director prototype route
  - current release-2 slice adds API-backed preview-session persistence (with local fallback) + constrained branch-choice summary
  - when unset on Vercel preview deployments, release-2 controls now default to enabled with the same preview-only fallback
  - keep `false` in production until release-2 preview-session behavior is validated
- `WEB_APP_BASE_URL`
  - set this to the deployed site URL for any redirects or generated links that depend on the web origin

Local-to-preview parity:
- local alternate web port:
  - `WEB_PORT=3001 WEB_APP_BASE_URL=http://localhost:3001 npm run dev:boot`
- deployed preview:
  - use the same `NEXT_PUBLIC_API_BASE_URL` shape you expect in production/staging

## Railway API + Worker Deploy

Use Railway for both API and worker surfaces. If the worker service is not running, paid orders stay queued and final video delivery will not complete.

Recommended Railway service setup:
- API service
  - repo root: `/`
  - build command: `npm run build:api`
  - start command: `npm run start:api`
  - pre-deploy command: `npm run migrate:api`
- Worker service
  - repo root: `/`
  - build command: `npm run build:worker`
  - start command: `npm run start:worker`
  - no pre-deploy command

Why this shape:
- the repo is a shared npm monorepo
- API and worker both depend on the local `@little/shared` package
- building from repo root keeps shared package compilation explicit instead of relying on stale checked-in artifacts

Required Railway envs:
- API service
  - `DATABASE_URL`
  - `REDIS_URL`
  - `WEB_APP_BASE_URL`
  - `NEXT_PUBLIC_API_BASE_URL`
  - optional: `CORS_ALLOWED_ORIGINS` (comma-separated browser origins allowed for credentialed CORS; `WEB_APP_BASE_URL` origin is always allowed)
  - `PUBLIC_ASSET_BASE_URL`
  - `ASSET_SIGNING_SECRET`
  - `PARENT_AUTH_SECRET`
  - optional: `WORKER_HEARTBEAT_STALE_SEC` (default `90`)
- Worker service
  - `DATABASE_URL`
  - `REDIS_URL`
  - `WEB_APP_BASE_URL`
  - `PUBLIC_ASSET_BASE_URL`
  - `ASSET_SIGNING_SECRET`
  - optional: `WORKER_HEARTBEAT_INTERVAL_MS` (default `15000`)
  - provider-mode envs needed for your chosen run mode (`*_PROVIDER_MODE`, `*_PROVIDER_BASE_URL`, and provider API keys when not using stub)

Port behavior:
- local dev still uses `API_PORT`
- Railway injects `PORT`, and the API now binds to that automatically in production

Operational notes:
- `GET /health` is available for API health checks
- `GET /health/worker` returns worker heartbeat readiness (returns `503` when no fresh worker heartbeat exists)
- Railway pre-deploy commands run in a separate container, so use them for migrations only
- keep `PROVIDER_INTEGRATION_MODE=stub` (and worker provider modes `stub`) for initial UI/staging deploys unless real providers are configured
- if the web app is already live, run one deployed full order (`create -> upload -> approve -> pay -> render -> deliver`) to confirm finished-video output before calling deployment production-ready

## Built Features

This README intentionally keeps feature status high-level to avoid drift and duplicated ledgers.

Current shipped shape (summary):
- parent intake, script review, payment, and async render/delivery flow
- provider-assisted pipeline (moderation, voice, scene render, compose) with retry/triage tooling
- parent status + gift flows and admin operational dashboards
- retention/deletion lifecycle controls and reliability guardrails

For the full implementation ledger and historical execution updates, use [TASKS.md](/home/totallymajor/projects/LittleLegendStudios/TASKS.md).

## Documentation Governance

Documentation ownership, anti-redundancy rules, and required update triggers are in [docs/runbooks/docs-governance.md](/home/totallymajor/projects/LittleLegendStudios/docs/runbooks/docs-governance.md).

## Remaining Work

All open tasks and backlog tracking are maintained in one place: [TASKS.md](/home/totallymajor/projects/LittleLegendStudios/TASKS.md).

Use `TASKS.md` `Next Up`, `Architecture And Scale Hardening Backlog (2026-03-14)`, and `Remaining Work Summary` as the canonical planning source.

## Notes

- Stripe is integrated with optional real mode (`STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET`).
- Asset URLs are HMAC-signed (`ASSET_SIGNING_SECRET`) with TTL controls and stored under `ASSET_LOCAL_ROOT` for local dev.
- Web port controls:
  - `WEB_PORT` controls the local Next.js port for `npm run dev` / `npm run dev:boot`
  - `WEB_APP_BASE_URL` should match that port for checkout/status redirects
- Email provider modes:
  - `EMAIL_PROVIDER_MODE=stub` (default, logs to stdout)
  - `EMAIL_PROVIDER_MODE=resend` + `RESEND_API_KEY` (real delivery)
  - `EMAIL_FROM` controls sender identity.
- Parent auth token controls:
  - `PARENT_AUTH_SECRET` (HMAC secret for signed parent access tokens)
  - `PARENT_AUTH_TTL_SEC` (token lifetime)
  - browser flows rely on cookie issuance (`Set-Cookie`) and `credentials: include`; create/gift auth payloads still include `parentAccessToken` bootstrap fields for split-host order-status session bridging
  - cookie-authenticated parent mutation requests now require an allowed browser `Origin` (same allowlist used by credentialed CORS)
- Refund policy control:
  - `AUTO_REFUND_ON_FAILURE=false` keeps failed renders in recoverable statuses (`failed_hard`/`manual_review`) for triage + retry
  - set `AUTO_REFUND_ON_FAILURE=true` only when automatic charge reversal on hard-failure is explicitly desired
- To run model + scene generation through local API provider routes, set worker envs:
  - `MODERATION_PROVIDER_MODE=http`
  - `MODERATION_PROVIDER_BASE_URL=http://localhost:4000`
  - `VOICE_PROVIDER_MODE=http`
  - `VOICE_PROVIDER_BASE_URL=http://localhost:4000`
  - `SCENE_PROVIDER_MODE=http`
  - `SCENE_PROVIDER_BASE_URL=http://localhost:4000`
- API integration modes:
  - `PROVIDER_INTEGRATION_MODE=stub` (always deterministic stub behavior)
  - `PROVIDER_INTEGRATION_MODE=hybrid` (try real provider calls when keys are set, fallback on failure)
  - `PROVIDER_INTEGRATION_MODE=strict` (fail request if provider config/calls fail)
- Moderation external vision model bridge (optional):
  - `MODERATION_EXTERNAL_MODEL_MODE=off|hybrid|strict`
  - `MODERATION_EXTERNAL_MODEL_BASE_URL` (external CV/NSFW scoring service)
  - `MODERATION_EXTERNAL_MODEL_PATH` (default `/v1/moderation/photo-scores`)
  - `MODERATION_EXTERNAL_MODEL_API_KEY` (optional bearer token)
- Provider task controls:
  - `PROVIDER_TASK_POLL_MIN_INTERVAL_MS` (API-side refresh throttling)
  - `PROVIDER_TASK_ASSUME_SUCCESS_AFTER_SEC` (hybrid-mode fallback when provider polling is unavailable)
  - `PROVIDER_TASK_POLL_INTERVAL_MS` / `PROVIDER_TASK_POLL_TIMEOUT_MS` (worker-side polling loop)
  - `PROVIDER_WEBHOOK_SECRET` (optional auth for provider webhook callbacks)
- Real provider envs:
  - `ELEVENLABS_API_KEY` (+ optional `ELEVENLABS_FALLBACK_VOICE_ID`)
  - `HEYGEN_API_KEY`
  - `SHOTSTACK_API_KEY`
- Optionally protect provider routes with `PROVIDER_AUTH_TOKEN` (set in API + worker env).
- Optional retention automation:
  - `ORDER_DATA_RETENTION_ENABLED=true`
  - `ORDER_DATA_RETENTION_DAYS`
  - `ORDER_DATA_RETENTION_SWEEP_INTERVAL_MS`
  - `ORDER_DATA_RETENTION_SWEEP_LIMIT`
- Admin visibility routes:
  - `GET /admin/order-data-purges`
  - web view at `/admin/retention-history`
- This is a foundation for Milestones M1-M3 from the product spec.
