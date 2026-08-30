#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
IMAGE="${HIBISCUS_MCP_IMAGE:-ghcr.io/safrano9999/hibiscus-mcp:latest}"
BASE=ghcr.io/safrano9999/hibiscus-mcp
RUN_CONFIG=true

case "${1:-}" in
  "") ;;
  --no-config) RUN_CONFIG=false ;;
  -h|--help)
    echo 'Usage: ./setup.sh [--no-config]'
    exit 0
    ;;
  *) echo "Unknown option: $1" >&2; exit 2 ;;
esac

cd "$SCRIPT_DIR"
$RUN_CONFIG && ./config.sh
for file in hibiscus-mcp.env hibiscus-mcp_config.conf hibiscus-mcp_container.conf; do
  [ ! -f "$file" ] || chmod 0600 "$file"
done

image_ref="$IMAGE"
if command -v podman >/dev/null 2>&1 && podman image exists "$IMAGE"; then
  digest="$(podman image inspect --format '{{.Digest}}' "$IMAGE")"
  [ -z "$digest" ] || image_ref="${BASE}@${digest}"
else
  echo 'Container image not local; use: sudo podman-smart1.sh --update' >&2
fi
CONFIG_CONTAINER_IMAGE="$image_ref" ./config.sh --render-container

node_bin="$(scripts/setup-node.sh)"
export HIBISCUS_MCP_NODE="$node_bin"
export PATH="$(dirname "$node_bin"):$PATH"
if ! npm --prefix "$SCRIPT_DIR" ls --omit=dev --depth=0 >/dev/null 2>&1; then
  npm --prefix "$SCRIPT_DIR" ci --omit=dev
fi
scripts/setup-supergateway.sh

service=hibiscus-mcp.service
template="$SCRIPT_DIR/systemd/$service.in"
rendered="$SCRIPT_DIR/$service"
content="$(<"$template")"
content="${content//@PROJECT_DIR@/$SCRIPT_DIR}"
content="${content//@CONFIG_FILE@/$SCRIPT_DIR/hibiscus-mcp_config.conf}"
content="${content//@ENV_FILE@/$SCRIPT_DIR/hibiscus-mcp.env}"
content="${content//@NODE_BIN@/$node_bin}"
printf '%s\n' "$content" > "$rendered"
chmod 0644 "$rendered"

user_units="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
container_units="${XDG_CONFIG_HOME:-$HOME/.config}/containers/systemd"
printf '\nSetup complete. Node: %s (%s)\n' "$node_bin" "$("$node_bin" --version)"
printf '\nChoose exactly one deployment:\n'
printf '\nBare metal:\n  mkdir -p %q && ln -sfn %q %q\n' \
  "$user_units" "$rendered" "$user_units/$service"
printf '\nContainer Quadlet:\n  mkdir -p %q && ln -sfn %q %q\n' \
  "$container_units" "$SCRIPT_DIR/hibiscus-mcp.container" \
  "$container_units/hibiscus-mcp.container"
printf '\nThen run:\n  systemctl --user daemon-reload && systemctl --user restart hibiscus-mcp.service\n'
