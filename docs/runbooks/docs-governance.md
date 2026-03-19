# Documentation Governance Runbook

## Purpose
Keep delivery speed high without letting implementation and docs drift apart.

This runbook defines:
- canonical ownership for each major document
- required update paths when code/config changes
- anti-redundancy constraints
- agent-specific control gates for reliability, performance, and UX quality

## Canonical Ownership Matrix
- `TASKS.md`: canonical build ledger, execution history, current backlog.
- `README.md`: high-level operational guide (boot, smoke, deploy entrypoints), not the full feature ledger.
- `docs/runbooks/tech-stack.md`: canonical inventory of meaningful technology choices.
- `docs/runbooks/agent-autopilot.md`: canonical operating contract for agent dispatch/automerge/failsafe.
- `docs/runbooks/deploy-*.md`: deployment-surface-specific procedures and post-deploy checks.

If content appears in more than one place, this matrix decides precedence.

## Update Triggers (Required)
- Product behavior change (`apps/*`, `packages/*`, major workflow change):
  - update `TASKS.md`.
- Meaningful technology addition/removal/replacement:
  - update `docs/runbooks/tech-stack.md`
  - update `README.md` `Stack` section
  - update `TASKS.md` when build shape changes.
- Agent pipeline/workflow contract changes:
  - update `docs/runbooks/agent-autopilot.md`
  - update `TASKS.md` when operational behavior changes.
- Env schema changes:
  - update `.env.example`
  - update relevant runbook/README sections where operator behavior changes.

## Anti-Redundancy Rules
- Do not maintain exhaustive feature status in `README.md`; keep that in `TASKS.md`.
- Do not duplicate stack ownership in multiple docs; `tech-stack.md` is canonical.
- Prefer linking to canonical sections instead of restating long checklists.
- When in doubt, shorten duplicated content and point to the source-of-truth file.

## Agent Control Gates
- Required quality gates before release:
  - `npm run typecheck`
  - `npm run build`
  - smoke verification when API/worker paths changed.
- Required governance gate:
  - `npm run docs:check` must pass for PRs that modify behavior, stack, env contracts, or agent controls.
- Required PR contract headings:
  - `Summary`
  - `Files changed`
  - `Docs impact`
  - `Risks / follow-ups`
  - `Commands run`
  - `Tests/lint/build results`
- Repo-level PR gate:
  - `.github/workflows/pr-body-contract.yml` enforces `## Docs impact` in all PR bodies.

## Performance + UX Balance Guardrails
- Do not accept "latest dependency" updates without impact checks:
  - startup/runtime impact
  - build-time impact
  - user-visible UX regressions.
- For user-surface changes, preserve responsiveness and readability on mobile and desktop.
- Keep rollout and rollback commands explicit whenever deploy behavior changes.

## Audit Cadence
- Per PR: automated docs-sync guard + codex docs review.
- Weekly: agent runbook and workflow parity review.
- Per release: verify `TASKS.md` reflects shipped behavior and unresolved risks.
