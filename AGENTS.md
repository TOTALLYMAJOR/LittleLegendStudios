# AGENTS.md

## Purpose

This repo expects new Codex sessions to rehydrate context from the project docs before making changes.

## Required Startup Workflow

Before implementing, reviewing, or proposing changes:

1. Read [TASKS.md](/home/totallymajor/projects/LittleLegendStudios/TASKS.md) first.
2. Read the `New Session Handoff` section in [TASKS.md](/home/totallymajor/projects/LittleLegendStudios/TASKS.md) in full.
3. Read [README.md](/home/totallymajor/projects/LittleLegendStudios/README.md) for setup, boot, smoke, and deployment context.
4. Run `git status --short` before editing so you know whether the tree already contains user or generated changes.
5. Treat this repo as an already-substantial implementation, not a blank scaffold.

## Source Of Truth

- [TASKS.md](/home/totallymajor/projects/LittleLegendStudios/TASKS.md) is the canonical build ledger and the main session-handoff document.
- [README.md](/home/totallymajor/projects/LittleLegendStudios/README.md) stays high-level and operational.
- If they appear to conflict, prefer [TASKS.md](/home/totallymajor/projects/LittleLegendStudios/TASKS.md) for current build status and implementation scope.

## Working Rules

- Do not start feature work until you have read the handoff context in [TASKS.md](/home/totallymajor/projects/LittleLegendStudios/TASKS.md).
- When changing meaningful product behavior or shipping new implementation, update [TASKS.md](/home/totallymajor/projects/LittleLegendStudios/TASKS.md) so the next session inherits accurate context.
- Prefer extending existing flows in `apps/api`, `apps/worker`, and `apps/web` over rewriting patterns from scratch.
- Use `npm run dev:boot` for the normal local startup path and `npm run smoke` for the main happy-path verification flow.

## Child-Director Extension Guardrails

### Goal

Extend the existing product with a child-directed creation experience for ages 3-12,
while preserving current production behavior, deployment stability, and parent safety controls.

### Product context

This repo powers a Next.js application hosted via Vercel and/or Railway.
The new feature area is "child-director experience" with:
- age-adaptive UI modes
- child input processing
- parent approval workflows
- real-time preview support
- dual output support

### Current priorities

1. Preserve existing flows and APIs unless explicitly asked to change them.
2. Build in vertical slices behind feature flags.
3. Prefer additive changes over refactors.
4. Keep deployment-safe boundaries and reversible diffs.

### Non-negotiable constraints

- Do not rename public routes or environment variables unless instructed.
- Do not change deployment configuration without documenting the impact.
- Do not commit secrets or sample real credentials.
- Do not introduce heavy dependencies without justification.
- Keep changes scoped to the requested feature or bug.

### Architecture rules

- Keep domain types separate from UI components.
- Put business logic in feature/application or lib modules, not inside React components.
- Prefer server actions / route handlers only where justified by the current codebase pattern.
- Add feature flags for incomplete work.
- Make child safety and parent approvals explicit in code paths.

### Testing rules

- Add or update unit tests for all non-trivial logic.
- Add one happy-path integration test per new slice.
- Add validation tests for approval gate logic and age-mode branching.
- Never claim completion if tests or lint are failing.

### Output format expected from Codex

For every significant task:
1. Summary of what changed
2. Files changed
3. Risks / follow-ups
4. Commands run
5. Result of tests/lint/build

### Safe working pattern

- First inspect relevant files.
- Then propose the smallest safe plan.
- Then implement in small commits.
- Then run validation.
- Then summarize remaining risks.

### Areas likely relevant

- `src/app` (or `apps/web/app` in this monorepo)
- `src/components` (or `apps/web/app` + feature component directories)
- `src/features` (or `apps/*/src` feature modules)
- `src/lib` (or `apps/*/src` and `packages/shared/src`)
- `docs`
- `package.json`
- deployment config files

### Areas likely sensitive

- auth
- billing
- production API routes
- deployment config
- existing render pipeline
