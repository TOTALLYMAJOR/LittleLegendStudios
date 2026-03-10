# ADR-003: Lightweight Preview Pipeline First

- Status: Accepted
- Date: 2026-03-09

## Context
Full preview rendering is high-cost and tightly coupled to the render pipeline.

## Decision
Start with lightweight previews (thumbnail plus short audio) and a simple session state object.

## Consequences
- Lower implementation risk.
- Faster iteration on UX.
- Full pipeline integration deferred until core flow is stable.
