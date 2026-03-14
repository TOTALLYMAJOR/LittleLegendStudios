# Child Director Workflows

## Planned sequence
1. Foundation contracts and feature flag.
2. Explorer mode slice (ages 6-8).
3. Parent approval gate service.
4. Preview session thumbnail plus short audio.
5. Limited story branching (three choices, one depth).
6. Toddler voice-first enhancements.

## Current slice status
- Steps 1-3 are complete in the current repo.
- Step 4 core implementation is shipped behind `NEXT_PUBLIC_CHILD_DIRECTOR_RELEASE2_ENABLED` with API-backed preview-session persistence, local fallback, constrained branch-choice summary, and structured prompt-bundle export support.
- Steps 5-6 are still planned and not yet shipped.

## Guardrails
- Any incomplete slice must be feature-flagged.
- Parent approval gates must block protected actions.
- Existing create and render flow must remain functional when feature is off.
