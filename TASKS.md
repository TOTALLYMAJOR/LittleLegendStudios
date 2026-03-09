# Build Status

This file is the canonical build ledger for the repo.

- `README.md` is the high-level product + setup summary.
- `TASKS.md` is the detailed source of truth for what is built, what is partially hardened, and what is next.

## New Session Handoff

This section is the fastest way for a new Codex 5.3 session to get oriented without rereading the whole repo.

- Product shape
  - monorepo for personalized cinematic child story videos
  - `apps/web` is the parent/admin Next.js surface
  - `apps/api` is the Fastify API, DB migration owner, and most business logic entrypoint
  - `apps/worker` runs the async render pipeline
  - `packages/shared` holds shared TypeScript domain types/utilities

- Start here
  - read `README.md` for boot/deploy commands
  - use `npm run dev:boot` for a normal local start
  - use `npm run smoke` after API + worker are running to verify the main happy path

- Local defaults expected by the repo
  - web: `http://localhost:3000`
  - api: `http://localhost:4000`
  - Postgres: local `DATABASE_URL`
  - Redis: local `REDIS_URL`
  - assets: API-served local signed upload/download flow under `/assets/*`

- Files that matter most for a fresh session
  - `apps/api/src/index.ts`: main API routes, payment flow, order lifecycle, retention hooks
  - `apps/api/src/provider-routes.ts`: provider-facing routes/contracts for moderation, voice, scene render, and compose
  - `apps/worker/src/index.ts`: orchestration for moderation, voice, render, compose, retry, and delivery
  - `apps/web/app/create/page.tsx`: main parent intake and session recovery entrypoint
  - `scripts/smoke.mjs`: end-to-end automation for the intended happy path
  - `packages/shared/src/*`: shared domain model used across app boundaries

- What is already true
  - the repo is beyond scaffold stage; parent flow, async render pipeline, provider contracts, gift flows, retry/admin tooling, and retention/delete flows all exist
  - smoke coverage exists for the core create -> upload -> approve -> pay -> render -> deliver -> gift flow
  - provider integrations support stub/hybrid/strict-style operation, but production quality still depends on real external providers and polish work

- What is still not done
  - moderation is explicit and structured, but still heuristic-first rather than production-grade model-backed review
  - character identity reuse exists in the pipeline, but there is no parent-facing management surface
  - final compose works, but subtitle branding, mix polish, and finishing quality still need more work
  - parent/admin web UX is functional but still scaffold-level in key areas (guided intake, upload clarity, parent-facing status readability, admin mobile responsiveness, and accessibility polish)

- Working assumptions for the next session
  - prefer updating this file when meaningful build state changes land
  - keep `README.md` high-level and keep detailed implementation status here
  - check `git status` before editing because generated artifacts can appear modified
  - do not treat the project as a blank MVP scaffold; most core flows already exist and usually need extension/hardening rather than first-pass implementation

## Built End To End

- [x] Core platform foundation
  - monorepo with `web`, `api`, `worker`, and `shared` packages
  - local Postgres + Redis dev stack
  - DB migrations and one-command local boot
  - signed local asset upload/download store

- [x] Parent intake + order creation
  - user creation and order creation
  - theme selection
  - selected-theme 3-second fast-cut preview in the create flow
  - parental consent capture
  - signed upload flow for 5-15 photos and exactly 1 voice sample
  - upload content-type and size validation
  - guided 4-step create-flow UI with per-step completion/status messaging
  - upload selection summaries plus in-flow upload progress feedback
  - drag/drop upload zones and per-file remove/retry controls for intake media
  - thumbnail-style photo previews for selected intake files

- [x] Script generation + review
  - template-based script generation
  - studio-grade beat-writing prompt engine with theme-aware narration/dialogue language
  - manifest-driven shot templates and target durations
  - max 3 script versions per order
  - script approval before payment
  - signed watermarked preview artifact for parent review

- [x] Parent auth + ownership enforcement
  - signed parent access token issuance
  - order status, retry, and gift-link actions gated by ownership
  - unauthorized/session-expired recovery path in the web flow
  - browser-session token bridge: create/gift flows persist token to both localStorage + cookie, and order status performs one-time browser-token auto-restore when cookie is missing

- [x] Payment + checkout path
  - Stripe stub and optional real checkout mode
  - webhook handling
  - payment idempotency protection
  - replay protection for Stripe webhooks

- [x] Worker render pipeline
  - moderation step
  - voice clone step
  - voice render step
  - character pack step
  - shot render step
  - final compose step
  - delivery notification step

- [x] Theme + scene manifest system
  - seeded launch themes
  - 10-scene manifests per theme
  - scene anchors, asset pointers, palette, FX, grade, camera metadata
  - shot template metadata for planner-driven scripts
  - seeded placeholder theme audio assets for ambience, music beds, and SFX

- [x] Character + voice scaffolding
  - deterministic character profile scaffold from uploaded photos
  - reusable character identity persistence keyed by parent + photo-set fingerprint
  - character identity reuse across later orders with fresh order-local refs artifacts
  - voice clone metadata persistence
  - aggregate narration/dialogue track generation
  - per-shot audio artifact generation and persistence

- [x] Shot planning + render metadata
  - manifest-driven planner instead of fixed hard-coded shot arrays
  - speaking budget + final mix metadata in script payloads
  - per-shot `sceneRenderSpec` resolution in API and worker
  - persisted shot metadata for compose-time introspection

- [x] Final video composition
  - real Shotstack timeline assembly from persisted shot artifacts
  - exact per-shot audio preferred, aggregate-track fallback
  - seeded theme music bed layering
  - music ducking support
  - branded subtitle layouts with style-aware timing and wrapping
  - thumbnail artifact generation path

- [x] Provider integrations + orchestration
  - moderation provider contract and route
  - internal provider routes for voice, scene render, and final compose
  - ElevenLabs integration path for voice clone + voice render
  - HeyGen integration path for shot generation
  - Shotstack integration path for final compose
  - hybrid/strict/stub provider execution modes
  - provider task polling + webhook persistence

- [x] Parent experience
  - order status page
  - preview visibility
  - render lifecycle visibility
  - structured moderation report visibility (decision, checks, score bands, reasons)
  - parent-facing retry endpoint with limits
  - gift link create, inspect, redeem, resend, revoke, regenerate

- [x] Admin + support tooling
  - dead-letter render queue visibility and retry
  - email notification failure dashboard
  - retry request history dashboard
  - moderation review dashboard with decision/status filters and evidence drilldown
  - moderation case actions with admin approve/reject override, required audit notes, and persisted action history
  - provider task failure triage dashboard
  - retention and purge history dashboard

- [x] Email + notifications
  - delivery-ready email
  - render-failure email
  - gift redemption email flow
  - notification outcome logging in `email_notifications`

- [x] Reliability + observability
  - enqueue dedupe persistence
  - dead-letter/retry observability
  - provider task state persistence
  - order status provider task visibility
  - scene-plan and render metadata introspection in order status

- [x] Data deletion + retention
  - manual `POST /orders/:orderId/delete-data`
  - best-effort provider cleanup hooks for ElevenLabs, HeyGen, and Shotstack
  - discovered-target coverage and verification reporting for provider cleanup outcomes
  - local cleanup of uploads, artifacts, scripts, jobs, and provider tasks
  - retention sweep runner on API startup + interval
  - automatic purge for aged `delivered`, `refunded`, and `expired` orders when enabled
  - persisted purge event history for manual deletes and sweep outcomes

- [x] Delivery + CI
  - GitHub Actions CI
  - repo typecheck pipeline
  - smoke test flow for the core happy path

## Built But Still Scaffolded

- [x] Moderation is real local heuristic moderation now
  - file signature validation
  - byte-count integrity checks
  - photo-set uniqueness heuristics
  - image dimension and framing heuristics
  - WAV voice-duration, silence, level, and sample-rate heuristics
  - explicit moderation decisions for pass, manual review, and reject
  - still not provider-grade CV/audio moderation

- [x] Moderation provider contract exists
  - worker can call dedicated moderation provider through `stub` or `http` mode
  - API exposes `/moderation/check` with structured category-level outcomes
  - moderation now computes scored photo quality, face confidence, NSFW risk, and voice intelligibility bands
  - moderation now supports optional external CV/NSFW score bridge (`off` / `hybrid` / `strict`) with per-photo fallback handling
  - moderation evidence now includes threshold profile + per-asset score breakdowns for triage/support
  - local heuristics remain the hard baseline in the worker

- [x] Character identity lifecycle exists, but product surface is still thin
  - reusable identity persistence and reuse now exist behind the worker pipeline
  - no parent-facing identity management or curation flow yet

- [x] Provider cleanup is best-effort
  - local deletion always completes
  - provider-side deletion failures are reported but do not block local purge

- [x] Theme audio is seeded placeholder material
  - compose path is real
  - production-quality licensed music/SFX pipeline is not built yet

## Current Product Shape

- [x] Current shipped build definition
  - template-first personalized child story videos
  - web-first parent flow
  - immersive Story Worlds landing showcase with orchestrated scene-beat transitions
  - premium seeded 64-84 second outputs today
  - 8-beat theme packs with explicit scene-to-beat planning
  - manifest-driven shot planning
  - provider-assisted render pipeline
  - async delivery with status tracking and retries

## UI/UX Review Backlog (2026-03-09)

- [ ] Parent intake flow hardening (`apps/web/app/create/page.tsx`)
  - first pass shipped: guided stepper with explicit progression and per-step completion states
  - first pass shipped: per-step request states and clearer local success/error messaging
  - add draft persistence for in-progress intake values so accidental refresh/navigation is less destructive
- [ ] Upload UX and validation polish (`apps/web/app/create/page.tsx`)
  - first pass shipped: selected-file summaries and upload progress indicators
  - second pass shipped: drag/drop support for photo + voice inputs
  - second pass shipped: per-file validation feedback plus retry/remove controls
  - third pass shipped: thumbnail-style visual previews for selected photos
  - keep backend constraints visible in UI copy (5-15 photos, one voice sample, accepted formats/duration)
- [ ] Parent status readability and focus (`apps/web/app/orders/[id]/page.tsx`, `apps/web/app/orders/[id]/OrderActions.tsx`)
  - split customer-facing journey summary from technical diagnostics to reduce cognitive load for non-technical parents
  - emphasize next recommended action per status and reduce raw JSON exposure by default
  - tighten action-state feedback for retry/gift flows (clear disabled reasons, pending states, and completion confirmations)
- [ ] Accessibility and interaction quality (`apps/web/app/globals.css`, `apps/web/app/StoryWorldsSection.tsx`)
  - add stronger `:focus-visible` treatments and clear invalid/error input states
  - refine live-region usage for rotating/animated content and add explicit pause/play affordance for world auto-rotation
  - keep reduced-motion parity and verify contrast/readability in all key flows
- [ ] Admin usability pass (`apps/web/app/admin/*`, `apps/web/app/globals.css`)
  - improve wide-table behavior for smaller screens (mobile card fallback or priority-column collapse)
  - standardize status/feedback surfaces and spacing for dense operational pages
  - preserve high-information admin workflows while improving scannability
- [ ] Landing information architecture cleanup (`apps/web/app/page.tsx`)
  - keep parent conversion path primary and move admin entry points to lower-prominence placement
  - preserve current visual direction while reducing CTA competition in hero/support zones

## Next Up

- [ ] Replace heuristic moderation with stronger media-quality and safety checks
  - calibrate voice intelligibility thresholds against labeled production samples
  - tune and validate external CV/NSFW model calibration + fallback policy using production-like labeled sets
- [ ] Add richer branded subtitle system and more final compose polish
  - keep pushing subtitle styling and final brand treatment beyond the current richer layout set
  - keep polishing music, audio mix, and finishing details
- [ ] Ship a product-grade parent/admin UX pass across intake, status, admin, and accessibility surfaces
  - implement the `UI/UX Review Backlog (2026-03-09)` items in phased slices with smoke-verified behavior parity
  - prioritize parent conversion/clarity first, then admin responsiveness and deeper design-system consistency

## Remaining Work Summary

- Moderation still needs a real production-grade safety and quality backend
- Moderation decisions are explicit now, but the evidence is still heuristic and not model-backed
- Character identity still needs a parent-facing management and curation surface
- Final compose still needs deeper polish around subtitle branding, audio finishing, and presentation quality
- Parent/admin web UX still needs a product-grade pass for flow clarity, accessibility, and responsive operability

## Notes

- When `ORDER_DATA_RETENTION_ENABLED=false`, retention automation is disabled and cleanup remains manual.
- This file replaces the older narrow task list; update this ledger when features land so build status stays accurate from start to finish.
