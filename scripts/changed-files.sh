#!/usr/bin/env bash
set -euo pipefail

BASE_REF="${1:-origin/main}"

if ! git rev-parse --verify "$BASE_REF" >/dev/null 2>&1; then
  BASE_REF="main"
fi

if ! git rev-parse --verify "$BASE_REF" >/dev/null 2>&1; then
  echo "Base reference not found; showing working tree status instead."
  git status --short
  exit 0
fi

git diff --name-status "$BASE_REF"...HEAD

if [[ -n "$(git status --short)" ]]; then
  echo
  echo "Working tree changes:"
  git status --short
fi
