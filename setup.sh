#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
IMAGE="${HIBISCUS_MCP_IMAGE:-ghcr.io/safrano9999/hibiscus-mcp:latest}"
BASE="ghcr.io/safrano9999/hibiscus-mcp"

cd "$SCRIPT_DIR"
podman image exists "$IMAGE" || {
    echo 'Image missing. Run: sudo podman-smart1.sh --update' >&2
    exit 1
}
digest="$(podman image inspect --format '{{.Digest}}' "$IMAGE")"
./config.sh
CONFIG_CONTAINER_IMAGE="${BASE}@${digest}" ./config.sh --render-container

unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/containers/systemd"
mkdir -p "$unit_dir"
ln -sfn "$SCRIPT_DIR/hibiscus-mcp.container" "$unit_dir/hibiscus-mcp.container"
systemctl --user daemon-reload
systemctl --user restart hibiscus-mcp.service
printf 'Hibiscus MCP started with %s@%s\n' "$BASE" "$digest"
