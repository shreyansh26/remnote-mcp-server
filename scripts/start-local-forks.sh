#!/usr/bin/env bash
set -euo pipefail
task_root="$(cd -- "$(dirname -- "$0")/../.." && pwd)"
if [[ ! -f "$task_root/remnote-mcp-server/dist/index.js" || ! -f "$task_root/remnote-mcp-bridge/dist/index.html" ]]; then
  echo "Build both sibling checkouts first: run npm ci and npm run build in each repo." >&2
  exit 1
fi
for port in 3001 3002 8080; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "Port $port is occupied. Stop its existing service manually before starting the local forks." >&2
    exit 1
  fi
done
export REMNOTE_SEMANTIC_DIR="${REMNOTE_SEMANTIC_DIR:-$task_root/.runtime/semantic}"
node "$task_root/remnote-mcp-bridge/bin/remnote-mcp-bridge.js" --port 8080 &
bridge_pid=$!
node "$task_root/remnote-mcp-server/dist/index.js" --http-host 127.0.0.1 --http-port 3001 --ws-port 3002 &
mcp_pid=$!
cleanup() {
  kill "$mcp_pid" "$bridge_pid" 2>/dev/null || true
  wait "$mcp_pid" "$bridge_pid" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
echo "Local MCP: http://127.0.0.1:3001/mcp"
echo "Local plugin: http://localhost:8080/ (RemNote Settings > Plugins > Build)"
wait "$mcp_pid"
