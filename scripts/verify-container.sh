#!/usr/bin/env bash
set -euo pipefail

IMAGE="${BIUNIVERS_CODEX_IMAGE:-biunivers-codex:dev}"
TEST_ROOT="$(mktemp -d)"
chmod 0777 "$TEST_ROOT"
CONTAINER="biunivers-codex-verify-$$"
cleanup() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  docker run --rm --user 0:0 --entrypoint chmod -v "$TEST_ROOT:/target" "$IMAGE" -R a+rwx /target >/dev/null 2>&1 || true
  rm -rf "$TEST_ROOT"
}
trap cleanup EXIT

docker build -t "$IMAGE" .
docker run --rm --entrypoint sh "$IMAGE" -c 'node --version && codex --version 2>/dev/null'
docker run -d --name "$CONTAINER" \
  --read-only --tmpfs /tmp:rw,noexec,nosuid,size=256m \
  --cap-drop ALL --security-opt no-new-privileges \
  --user 65532:65532 -p 127.0.0.1::8080 \
  -e BIUNIVERS_MODEL_BASE_URL=https://example.invalid/v1 \
  -e BIUNIVERS_MODEL_NAME=@cf/openai/gpt-oss-20b \
  -e BIUNIVERS_MODEL_API_KEY=verification-secret \
  -v "$TEST_ROOT:/workspace" "$IMAGE" >/dev/null

PORT="$(docker port "$CONTAINER" 8080/tcp | sed 's/.*://')"
READY=false
for _ in $(seq 1 40); do
  if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then READY=true; break; fi
  if test "$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null || echo false)" != true; then break; fi
  sleep 0.5
done
if test "$READY" != true; then
  echo "Biunivers Codex 未能就绪，容器日志：" >&2
  docker logs "$CONTAINER" >&2
  exit 1
fi
curl -fsS "http://127.0.0.1:$PORT/" | grep -q "Biunivers Codex"
test "$(docker inspect -f '{{.Config.User}}' "$CONTAINER")" = "65532:65532"
if docker exec "$CONTAINER" sh -c 'tr "\\0" "\\n" < /proc/1/environ | grep -q "^BIUNIVERS_MODEL_API_KEY="'; then
  echo "敏感变量仍存在于 PID 1 环境。" >&2
  exit 1
fi
if docker exec "$CONTAINER" test -e /tmp/.biunivers-model-api-key; then
  echo "一次性敏感变量文件未被删除。" >&2
  exit 1
fi
if docker exec "$CONTAINER" sh -c 'grep -R "verification-secret" /workspace >/dev/null 2>&1'; then
  echo "敏感变量被写入 Workspace。" >&2
  exit 1
fi
! docker logs "$CONTAINER" 2>&1 | grep -q "verification-secret"
echo "Biunivers Codex 非 root、只读根、HTTP 就绪与 secret 不落盘检查通过。"
