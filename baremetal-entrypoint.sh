#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
NODE="${HIBISCUS_MCP_NODE:-}"
[ -n "$NODE" ] || NODE="$(command -v node || true)"
[ -x "$NODE" ] || { echo 'Node.js is missing; rerun ./setup.sh' >&2; exit 1; }

printf -v stdio '%q %q' "$NODE" "$SCRIPT_DIR/server.mjs"
exec "$NODE" "$SCRIPT_DIR/.runtime/supergateway/dist/index.js" \
  --stdio "$stdio" --outputTransport streamableHttp --stateful \
  --host "${HIBISCUS_MCP_HOST:-127.0.0.1}" \
  --port "${HIBISCUS_MCP_PORT:-8000}" --streamableHttpPath /mcp \
  --healthEndpoint /healthz --sessionTimeout 3600000 --logLevel info
