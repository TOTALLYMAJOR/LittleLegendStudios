# Little Legend Studios MVP Scaffold

Template-first MVP scaffold for personalized cinematic child story videos.

## Stack

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
- run `npm install`
- run API DB migration
- start all services (`shared`, `api`, `worker`, `web`)

Optional flags:
- `SKIP_INFRA=1 npm run dev:boot`
- `SKIP_INSTALL=1 npm run dev:boot`
- `SKIP_MIGRATE=1 npm run dev:boot`

If you already run local Postgres/Redis and Docker reports `port is already allocated`, use:
- `SKIP_INFRA=1 npm run dev:boot`

### Manual boot

1. Copy env values:

```bash
cp .env.example .env
```

2. Start local infra:

```bash
docker compose -f infra/docker-compose.yml up -d
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

## Built Features

This repo is no longer just a thin scaffold. The current build includes:

- Parent intake + order creation
  - create user + order
  - signed upload/download URL flow with local binary asset store (`/assets/upload/*`, `/assets/download/*`)
  - parental consent gating
  - 5-15 photo uploads and exactly 1 voice upload

- Script generation + review
  - manifest-driven script planning
  - 20-40 second seeded outputs
  - max 3 script versions per order
  - signed watermarked preview artifact (`preview_video`)

- Render pipeline
  - moderation step with structured media checks (file signature, image dimensions, framing heuristics, and WAV voice analysis)
  - moderation provider contract via `/moderation/check`
  - voice clone + voice render
  - aggregate narration/dialogue tracks plus per-shot audio artifacts
  - character profile scaffold generation
  - shot render orchestration with per-shot `sceneRenderSpec`
  - real Shotstack final timeline assembly from persisted shot assets
  - per-shot voice tracks preferred with aggregate fallback
  - seeded theme music bed layering + music ducking
  - branded subtitle presets in final compose

- Theme system
  - seeded launch themes with 10-scene manifests each
  - richer scene metadata: anchors, palette, global FX, audio cues, grade, camera motion
  - seeded placeholder audio assets for ambience, music beds, and SFX

- Provider integrations
  - internal provider routes: `/voice/clone`, `/voice/render`, `/scene/*`
  - ElevenLabs integration path for voice clone + render
  - HeyGen integration path for shot generation
  - Shotstack integration path for final compose
  - provider task persistence, polling, webhook ingestion, and retry tooling

- Parent + admin experience
  - parent order status page with provider-task visibility
  - parent retry endpoint with limits
  - parent auth + ownership enforcement
  - gift link create / inspect / redeem / resend / revoke / regenerate
  - admin dead-letter retry view
  - email notification failure view
  - retry request history view
  - provider task failure triage view

- Reliability + lifecycle controls
  - Stripe stub + optional real checkout/webhook flow
  - payment idempotency
  - webhook replay protection
  - render enqueue dedupe persistence
  - delivery-ready and render-failure email logging
  - manual order data deletion
  - best-effort provider-side cleanup hooks
  - optional retention automation for aged delivered/refunded/expired orders

For the full build ledger, use [TASKS.md](/home/totallymajor/projects/LittleLegendStudios/TASKS.md).

## Notes

- Stripe is integrated with optional real mode (`STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET`).
- Asset URLs are HMAC-signed (`ASSET_SIGNING_SECRET`) with TTL controls and stored under `ASSET_LOCAL_ROOT` for local dev.
- Email provider modes:
  - `EMAIL_PROVIDER_MODE=stub` (default, logs to stdout)
  - `EMAIL_PROVIDER_MODE=resend` + `RESEND_API_KEY` (real delivery)
  - `EMAIL_FROM` controls sender identity.
- Parent auth token controls:
  - `PARENT_AUTH_SECRET` (HMAC secret for signed parent access tokens)
  - `PARENT_AUTH_TTL_SEC` (token lifetime)
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
- This is a foundation for Milestones M1-M3 from the product spec.
