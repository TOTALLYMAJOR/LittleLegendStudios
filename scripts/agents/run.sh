#!/usr/bin/env bash
set -euo pipefail

if [[ -f .env ]]; then
  while IFS= read -r line; do
    [[ -z "${line// }" ]] && continue
    [[ "$line" == \#* ]] && continue

    case "$line" in
      AGENT_*=*)
        key="${line%%=*}"
        value="${line#*=}"

        if [[ "$value" == \"*\" && "$value" == *\" ]]; then
          value="${value:1:${#value}-2}"
        elif [[ "$value" == \'*\' && "$value" == *\' ]]; then
          value="${value:1:${#value}-2}"
        fi

        export "${key}=${value}"
        ;;
    esac
  done < .env
fi

node scripts/agents/orchestrate.mjs "$@"
