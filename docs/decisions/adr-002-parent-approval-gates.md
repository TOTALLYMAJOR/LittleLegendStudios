# ADR-002: Centralized Parent Approval Gates

- Status: Accepted
- Date: 2026-03-09

## Context
Approval checks can sprawl across UI and service layers if not centralized.

## Decision
Use one centralized approval policy service for threshold and policy decisions.

## Consequences
- Clearer auditability and safer behavior.
- Lower risk of inconsistent gate behavior.
- Requires explicit interfaces between UI flow and policy service.
