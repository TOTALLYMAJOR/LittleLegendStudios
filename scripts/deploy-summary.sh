#!/usr/bin/env bash
set -euo pipefail

echo "Deploy summary"
echo "============="
echo "Date: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "Branch: $(git rev-parse --abbrev-ref HEAD)"
echo "Commit: $(git rev-parse --short HEAD)"

echo
echo "Changed files vs origin/main (if available):"
if git rev-parse --verify origin/main >/dev/null 2>&1; then
  git diff --name-status origin/main...HEAD || true
else
  echo "origin/main not found locally."
fi

if [[ -n "$(git status --short)" ]]; then
  echo
  echo "Working tree changes:"
  git status --short
fi

echo
echo "Environment check (set or missing):"
for var in NEXT_PUBLIC_API_BASE_URL WEB_APP_BASE_URL DATABASE_URL REDIS_URL PUBLIC_ASSET_BASE_URL ASSET_SIGNING_SECRET PARENT_AUTH_SECRET; do
  if [[ -n "${!var:-}" ]]; then
    echo "- $var: set"
  else
    echo "- $var: missing"
  fi
done
