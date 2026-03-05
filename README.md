# Little Legend Studios MVP Scaffold

Template-first MVP scaffold for personalized cinematic child story videos.

## Stack

- Web: Next.js (`apps/web`)
- API: Fastify + Postgres (`apps/api`)
- Worker: BullMQ + Redis (`apps/worker`)
- Shared domain: TypeScript package (`packages/shared`)
- Infra dev deps: Postgres + Redis (`infra/docker-compose.yml`)

## Quick Start

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

## Current Vertical Slice

- Create user + order
- Upload metadata intake (photo/voice signed URL stub)
- Intake gating before script generation:
  - parental consent required
  - 5-15 photos (JPEG/PNG)
  - exactly 1 voice sample (WAV/M4A)
- Script generation + approval (deterministic 4-shot, 20-40s structure, max 3 versions/order)
- Cinematic Prompt Engine scaffold (scene-aware shot plan with camera/lighting/environment cues)
- Theme scene packs in template manifests (10 scenes per launch theme with anchors and asset pointers)
- Expanded lifecycle states for retries/refunds (`failed_soft`, `failed_hard`, `refund_queued`, `manual_review`)
- Stripe checkout + webhook path (real when Stripe env vars are set, stub fallback otherwise)
- Worker pipeline consumes shot plans and writes per-shot `shot_video` artifacts
- Status polling + final artifact link stub

## Notes

- Stripe is integrated with optional real mode (`STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET`); storage/email/AI providers remain mocked.
- This is a foundation for Milestones M1-M3 from the product spec.
