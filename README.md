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

## Current Vertical Slice

- Create user + order
- Signed upload/download URL flow with local binary asset store (`/assets/upload/*`, `/assets/download/*`)
- Intake gating before script generation:
  - parental consent required
  - 5-15 photos (JPEG/PNG)
  - exactly 1 voice sample (WAV/M4A)
- Script generation + approval (deterministic 4-shot, 20-40s structure, max 3 versions/order)
- Script generation now also creates a signed watermarked preview artifact (`preview_video`) for parent review
- Cinematic Prompt Engine scaffold (scene-aware shot plan with camera/lighting/environment cues)
- Theme scene packs in template manifests (10 scenes per launch theme with anchors and asset pointers)
- Character DNA scaffold in worker (deterministic `character_refs` profile derived from uploaded photos)
- Expanded lifecycle states for retries/refunds (`failed_soft`, `failed_hard`, `refund_queued`, `manual_review`)
- Stripe checkout + webhook path (real when Stripe env vars are set, stub fallback otherwise)
- Worker pipeline consumes shot plans and writes `voice_clone_meta`, `audio_*`, `character_refs`, `shot_video`, and final artifacts
- Worker now materializes binary placeholder files for generated artifact keys so signed download links resolve immediately
- Worker attempts to ingest provider output URLs (when available from task polling) before falling back to placeholders
- Worker now compiles per-shot `sceneRenderSpec` payloads from theme manifests (assets, anchors, camera, lighting, environment motion, model profile)
- Worker provider adapters support `stub` and `http` modes for voice + scene generation services
- API now exposes internal provider endpoints for model + scene generation (`/voice/clone`, `/voice/render`, `/scene/*`)
- API provider endpoints support real integration attempts for ElevenLabs (voice), HeyGen (shot generation), and Shotstack (final compose) with fallback behavior.
- Provider task tracking with polling/webhook endpoints (`GET /provider-tasks/:id`, `POST /provider-tasks/webhook`) and DB persistence
- Provider task admin routes for monitoring/retry (`GET /provider-tasks`, `POST /provider-tasks/:id/retry`)
- Order status now includes provider task rows for live visibility in the status page
- Order status/create UI surfaces latest watermarked preview links when available
- Order status now includes computed per-shot scene plans with model profile tags (camera/lighting/assets/anchors) for render introspection
- Admin order retry endpoint: `POST /admin/orders/:orderId/retry` (token-gated via `ADMIN_API_TOKEN`)
- Parent-facing retry endpoint with limits: `POST /orders/:orderId/retry` (limit from `PARENT_MAX_RETRY_REQUESTS`)
- Gift redemption link flow:
  - create link: `POST /orders/:orderId/gift-link`
  - inspect link: `GET /gift/redeem/:token`
  - redeem link: `POST /gift/redeem/:token`
- Worker now sends delivery-ready and render-failure emails, and logs outcomes in `email_notifications`
- Status polling + final artifact link stub

## Notes

- Stripe is integrated with optional real mode (`STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET`).
- Asset URLs are HMAC-signed (`ASSET_SIGNING_SECRET`) with TTL controls and stored under `ASSET_LOCAL_ROOT` for local dev.
- Email provider modes:
  - `EMAIL_PROVIDER_MODE=stub` (default, logs to stdout)
  - `EMAIL_PROVIDER_MODE=resend` + `RESEND_API_KEY` (real delivery)
  - `EMAIL_FROM` controls sender identity.
- To run model + scene generation through local API provider routes, set worker envs:
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
- This is a foundation for Milestones M1-M3 from the product spec.
