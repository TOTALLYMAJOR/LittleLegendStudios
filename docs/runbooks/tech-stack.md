# Tech Stack Register

This file is the canonical technology inventory for the repo.

If a session introduces, replaces, or removes meaningful technology, update this file in the same change.

Last reviewed: 2026-03-10

## Core Platform

- Monorepo: npm workspaces (`apps/*`, `packages/*`)
- Language and runtime: TypeScript + Node.js (ESM modules)
- Shared domain package: `@little/shared` (`packages/shared`)

## Applications

- Web app (`apps/web`): Next.js 14 + React 18
- API (`apps/api`): Fastify, Zod, Postgres (`pg`), Redis (`ioredis`)
- Worker (`apps/worker`): BullMQ, Redis (`ioredis`), Postgres (`pg`)

## Data and Async Infrastructure

- Database: PostgreSQL
- Queue and async jobs: BullMQ
- Queue/cache backend: Redis
- Local infra orchestration: Docker Compose (`infra/docker-compose.yml`)

## Payments, Media, and Messaging Integrations

- Payments: Stripe
- Voice provider path: ElevenLabs
- Scene render provider path: HeyGen
- Final compose provider path: Shotstack
- Email provider modes: stub or Resend

## Deployment and Operations

- Web deployment target: Vercel
- API deployment target: Railway
- CI: GitHub Actions
- Local happy-path verification: `npm run smoke`

## Required Update Rules

When a change adds/removes/replaces framework/runtime/dependency/service/provider/deploy target:

1. Update this file (`docs/runbooks/tech-stack.md`).
2. Update the `README.md` `Stack` section.
3. Update `TASKS.md` if the build shape or implementation scope changed.
4. Mention "tech stack updated" in the task summary so reviewers can verify docs parity.
