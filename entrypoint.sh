#!/bin/bash
set -euo pipefail

if [[ -z "${BIUNIVERS_MODEL_API_KEY:-}" ]]; then
  echo "BIUNIVERS_MODEL_API_KEY is required." >&2
  exit 1
fi

MODEL_KEY_FILE=/tmp/.biunivers-model-api-key
(umask 077; printf '%s' "$BIUNIVERS_MODEL_API_KEY" > "$MODEL_KEY_FILE")
export BIUNIVERS_MODEL_KEY_FILE="$MODEL_KEY_FILE"
unset BIUNIVERS_MODEL_API_KEY CLOUDFLARE_API_KEY CLOUDFLARE_API_TOKEN
exec node /app/server.mjs
