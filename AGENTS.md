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
