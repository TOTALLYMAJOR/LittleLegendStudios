---
name: deployment-ops
description: Make deploy-safe changes for GitHub, Railway, and Vercel workflows.
---

# Use for
- env var changes
- build pipeline changes
- preview, staging, and release workflows
- deployment troubleshooting

# Rules
- Never print secrets.
- Document every new env var.
- Validate build locally before changing deployment config.
- Keep Vercel and Railway changes explicit and reversible.
