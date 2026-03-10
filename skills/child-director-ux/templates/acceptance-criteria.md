# Acceptance Criteria Template

## Functional
- [ ] Existing create flow remains unchanged when feature flag is off.
- [ ] Age-mode behavior is explicitly typed and branch-covered.
- [ ] Parent approval gate blocks guarded actions until approved.

## Quality
- [ ] New logic has unit tests.
- [ ] One happy-path integration check exists for the slice.
- [ ] Error states are visible and actionable.

## Operational
- [ ] No deployment config changes are required, or they are documented.
- [ ] Rollback path is documented.
