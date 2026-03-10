---
name: child-director-ux
description: Build and extend age-adaptive child creation workflows safely.
---

# When to use
Use for any request involving:
- ages 3-5, 6-8, 9-12 UI differences
- parent approvals
- story choices and branching
- preview sessions
- child-safe interaction design

# Required behavior
- Preserve existing production flows.
- Prefer additive feature slices.
- Keep age-mode branching explicit and typed.
- Keep parent approval logic centralized.
- Add tests for branching and gating.

# Deliverables
- domain types
- application service updates
- UI components
- tests
- docs updates

# Checklist
1. Identify current feature seam.
2. Add or extend typed domain contracts.
3. Implement smallest vertical slice.
4. Add feature flag if incomplete.
5. Run lint, test, and build where scripts exist.
6. Summarize risk and rollout notes.
