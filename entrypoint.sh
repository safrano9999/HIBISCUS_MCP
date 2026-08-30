#!/bin/sh
set -eu

exec node /opt/supergateway/dist/index.js \
  --stdio "node /opt/hibiscus-mcp/server.mjs" \
  --outputTransport streamableHttp --stateful \
  --port "${HIBISCUS_MCP_PORT:-8000}" --streamableHttpPath /mcp \
  --healthEndpoint /healthz --sessionTimeout 3600000 --logLevel info
