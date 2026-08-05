#!/bin/bash
set -euo pipefail

startup_error() { echo "BWA_STARTUP_ERROR: $1" >&2; exit 1; }

[[ -n "${CODEX_MODEL_BASE_URL:-}" ]] || startup_error "缺少普通配置 CODEX_MODEL_BASE_URL。"
[[ -n "${CODEX_MODEL_NAME:-}" ]] || startup_error "缺少普通配置 CODEX_MODEL_NAME。"
[[ -n "${CODEX_MODEL_API_KEY:-}" ]] || startup_error "缺少敏感配置 CODEX_MODEL_API_KEY。"
node -e 'const value=new URL(process.env.CODEX_MODEL_BASE_URL); if(value.protocol!=="https:") process.exit(1)' \
  2>/dev/null || startup_error "CODEX_MODEL_BASE_URL 必须是有效的 HTTPS 地址。"

MODEL_KEY_FILE=/tmp/.biunivers-model-api-key
(umask 077; printf '%s' "$CODEX_MODEL_API_KEY" > "$MODEL_KEY_FILE")
export CODEX_MODEL_KEY_FILE="$MODEL_KEY_FILE"
unset CODEX_MODEL_API_KEY CLOUDFLARE_API_KEY CLOUDFLARE_API_TOKEN
exec node /app/server.mjs
