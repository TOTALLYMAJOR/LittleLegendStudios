# Build Status

This file is the canonical build ledger for the repo.

- `README.md` is the high-level product + setup summary.
- `TASKS.md` is the detailed source of truth for what is built, what is partially hardened, and what is next.

## Built End To End

- [x] Core platform foundation
  - monorepo with `web`, `api`, `worker`, and `shared` packages
  - local Postgres + Redis dev stack
  - DB migrations and one-command local boot
  - signed local asset upload/download store

- [x] Parent intake + order creation
  - user creation and order creation
  - theme selection
  - parental consent capture
  - signed upload flow for 5-15 photos and exactly 1 voice sample
  - upload content-type and size validation

- [x] Script generation + review
  - template-based script generation
  - manifest-driven shot templates and target durations
  - max 3 script versions per order
  - script approval before payment
  - signed watermarked preview artifact for parent review

- [x] Parent auth + ownership enforcement
  - signed parent access token issuance
  - order status, retry, and gift-link actions gated by ownership
  - unauthorized/session-expired recovery path in the web flow

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
  - branded subtitle presets
  - thumbnail artifact generation path

- [x] Provider integrations + orchestration
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
  - parent-facing retry endpoint with limits
  - gift link create, inspect, redeem, resend, revoke, regenerate

- [x] Admin + support tooling
  - dead-letter render queue visibility and retry
  - email notification failure dashboard
  - retry request history dashboard
  - provider task failure triage dashboard

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
  - local cleanup of uploads, artifacts, scripts, jobs, and provider tasks
  - retention sweep runner on API startup + interval
  - automatic purge for aged `delivered`, `refunded`, and `expired` orders when enabled

- [x] Delivery + CI
  - GitHub Actions CI
  - repo typecheck pipeline
  - smoke test flow for the core happy path

## Built But Still Scaffolded

- [x] Moderation is real local heuristic moderation now
  - file signature validation
  - byte-count integrity checks
  - photo-set uniqueness heuristics
  - voice-duration heuristics
  - still not provider-grade CV/audio moderation

- [x] Character system is functional scaffold, not reusable identity product
  - deterministic profile generation exists
  - no long-lived reusable character identity lifecycle yet

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
  - 20-40 second seeded outputs today
  - manifest-driven shot planning
  - provider-assisted render pipeline
  - async delivery with status tracking and retries

## Next Up

- [ ] Replace heuristic moderation with stronger media-quality and safety checks
- [ ] Add dedicated retention/admin visibility for purge history and retention outcomes
- [ ] Improve provider deletion coverage and verification reporting
- [ ] Expand from current seeded 4-shot launch structure into richer premium theme packs
- [ ] Add reusable character identity lifecycle instead of per-order scaffolded DNA only
- [ ] Add richer branded subtitle system and more final compose polish

## Notes

- When `ORDER_DATA_RETENTION_ENABLED=false`, retention automation is disabled and cleanup remains manual.
- This file replaces the older narrow task list; update this ledger when features land so build status stays accurate from start to finish.
