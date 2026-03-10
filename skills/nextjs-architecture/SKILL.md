---
name: nextjs-architecture
description: Make safe architectural changes in the existing Next.js codebase.
---

# Use for
- app router changes
- route handlers
- state and data flow cleanup
- component decomposition
- performance-sensitive UI work

# Rules
- Match existing repo conventions first.
- Do not over-refactor.
- Prefer server and client boundaries that reduce complexity.
- Keep domain logic outside React components.
- Avoid adding new global state libraries unless necessary.
