# ADR-001: Feature Slices First

- Status: Accepted
- Date: 2026-03-09

## Context
Child-director work touches UI, API, worker orchestration, and safety controls. Large refactors increase release risk.

## Decision
Implement incremental vertical slices behind feature flags, starting with contracts and one age mode.

## Consequences
- Smaller, reversible diffs.
- Faster review cycles.
- Requires disciplined scope control and explicit docs updates.
