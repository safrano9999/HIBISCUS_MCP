#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
IMAGE="${HIBISCUS_IMAGE:-ghcr.io/safrano9999/hibiscus:latest}"
BASE=ghcr.io/safrano9999/hibiscus
NAME="${CONFIG_CONTAINER_NAME:-hibiscus}"

cd "$DIR"
CONFIG_CONTAINER_NAME="$NAME" ./config.sh
chmod 0600 "$NAME.env" "${NAME}_config.conf" "${NAME}_container.conf"

image_ref="$IMAGE"
if command -v podman >/dev/null 2>&1 && podman image exists "$IMAGE"; then
  digest="$(podman image inspect --format '{{.Digest}}' "$IMAGE")"
  [ -z "$digest" ] || image_ref="${BASE}@${digest}"
else
  echo 'Container image not local; use: sudo podman-smart1.sh --update' >&2
fi
CONFIG_CONTAINER_NAME="$NAME" CONFIG_CONTAINER_IMAGE="$image_ref" ./config.sh --render-container

units="${XDG_CONFIG_HOME:-$HOME/.config}/containers/systemd"
printf '\nSetup complete. Link the generated Quadlet with:\n'
printf '  mkdir -p %q && ln -sfn %q %q\n' \
  "$units" "$DIR/$NAME.container" "$units/$NAME.container"
printf 'Then: systemctl --user daemon-reload && systemctl --user restart %s.service\n' "$NAME"
