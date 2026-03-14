#!/usr/bin/env bash
set -euo pipefail

if ! command -v codex >/dev/null 2>&1; then
  echo "[agents:implementer] codex CLI is not installed or not in PATH." >&2
  exit 1
fi

if [[ -z "${RUN_DIR:-}" ]]; then
  echo "[agents:implementer] RUN_DIR is required." >&2
  exit 1
fi

PROMPT_FILE="${RUN_DIR%/}/implementer.prompt.md"

if [[ ! -f "$PROMPT_FILE" ]]; then
  echo "[agents:implementer] Prompt file not found: $PROMPT_FILE" >&2
  exit 1
fi

WORKDIR="${AGENT_WORKDIR:-$(pwd)}"

# Read prompt content from stdin via '-' so runbook prompts stay source-of-truth.
codex exec --full-auto -C "$WORKDIR" - < "$PROMPT_FILE"
