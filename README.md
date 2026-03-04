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
- Script generation + approval
- Payment simulation and async queue kickoff
- Worker mock pipeline to delivered/failure
- Status polling + final artifact link stub

## Notes

- Stripe, S3 signed URLs, email provider, and AI providers are currently mocked behind deterministic stubs.
- This is a foundation for Milestones M1-M3 from the product spec.
