#!/usr/bin/env bash
set -euo pipefail

npm run typecheck
npm run build

if [[ "${RUN_SMOKE:-0}" == "1" ]]; then
  bash ./scripts/smoke-local.sh
fi
