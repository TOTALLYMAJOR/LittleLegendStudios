# Child Director Overview

## Goal
Extend the current product with a child-directed creation experience for ages 3-12 without destabilizing parent and production flows.

## Principles
- Preserve current behavior by default.
- Build in vertical slices behind feature flags.
- Keep parent approval and safety checks explicit.
- Keep deployment and rollback paths simple.

## Initial scope
- Foundation contracts and feature flag.
- Explorer-mode first UI slice (ages 6-8).
- Centralized parent approval service.
- Release-2 pilot feature flag for preview-session controls.
- Lightweight preview session state.

## Current implementation note
- Release-2 pilot now includes API-backed preview-session persistence with local fallback plus constrained branch-choice summary (still prototype-only, feature-gated).
