# VS Code Hybrid Agent Autopilot Runbook

## Goal
Run a VS Code-first, CI-enforced multi-agent loop that claims tasks from `TASKS.md`, executes a fixed pipeline, and auto-merges eligible PRs with minimal human intervention.

## Canonical Task Source
- Task queue source of truth: `TASKS.md`
- Queue order:
  1. `Architecture And Scale Hardening Backlog (2026-03-14)`
  2. `Next Up`

## Local VS Code Control Plane
- Use `.vscode/tasks.json` tasks:
  - `Agents: Dispatch Next`
  - `Agents: Dispatch Batch`
  - `Agents: Dry Run`
  - `Agents: Resume Failed`
  - `Verify: Full`

## CLI Contracts
- Dispatch:
  - `node scripts/agents/orchestrate.mjs --mode=dispatch --profile=reliability --max-parallel=2 --automerge=true`
- Dry run:
  - `node scripts/agents/orchestrate.mjs --mode=dry-run --task-id=<id>`
- Queue listing:
  - `node scripts/agents/queue.mjs list --section="Architecture And Scale Hardening Backlog (2026-03-14)"`

## Pipeline Stages Per Task
1. Planner
2. Implementer
3. Verifier (`typecheck`, `build`, and smoke when API/worker paths change)
4. Reviewer (`npm run docs:check && npm run changed-files` by default)
5. Release (open PR + optional auto-merge)

Run artifacts are written to `.codex/runs/<task-id>/`.

## Required Environment For Full Automation
- `GITHUB_TOKEN` (push + PR scope)
- `OPENAI_API_KEY`
- `AGENT_IMPLEMENTER_CMD` (required for autonomous code changes)
- Optional:
  - `AGENT_PLANNER_CMD`
  - `AGENT_REVIEWER_CMD`
  - `AGENT_RELEASE_CMD`

If `AGENT_IMPLEMENTER_CMD` is not configured, dispatch marks the task as `blocked` and stops before code mutation.

Recommended implementer command:
- `bash ./scripts/agents/implementer.sh`

Where to configure:
- GitHub (`agent-dispatch` workflow): repository variable `AGENT_IMPLEMENTER_CMD`
- Local terminal/VS Code: environment variable `AGENT_IMPLEMENTER_CMD` (or set in `.env` and run via `scripts/agents/run.sh`)

GitHub CLI helper:
- `gh variable set AGENT_IMPLEMENTER_CMD --body 'bash ./scripts/agents/implementer.sh' --repo TOTALLYMAJOR/LittleLegendStudios`

## GitHub Workflows
- `agent-dispatch.yml`
  - Scheduled and manual orchestration dispatch
- `agent-automerge.yml`
  - Enforces PR body contract and enables auto-merge for `agent:auto`
- `agent-failsafe.yml`
  - Opens incident issues when agent PR checks fail repeatedly
- `pr-body-contract.yml`
  - Enforces `## Docs impact` in all pull request bodies

Existing required checks remain:
- `CI`
- `codex-review`
- `codex-docs`

Additional governance check:
- `docs:check` (runs in CI and default reviewer command path)

## PR Contract (Enforced)
Agent PR bodies must include:
- `Summary`
- `Files changed`
- `Docs impact`
- `Risks / follow-ups`
- `Commands run`
- `Tests/lint/build results`

## Operational Notes
- Recommended branch format: `agent/<track>/<slug>-<yyyymmdd>`.
- Maximum parallel active claims: `2`.
- If auto-resolution fails, orchestrator marks task as `failed` or `blocked`; use `Agents: Resume Failed` after remediation.
- Keep docs ownership and anti-redundancy policy aligned with [docs/runbooks/docs-governance.md](/home/totallymajor/projects/LittleLegendStudios/docs/runbooks/docs-governance.md).
