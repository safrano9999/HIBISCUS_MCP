#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
REVISION=a3ce8ba34c40f7565d1786e1dbd19621aca86093
TARGET="$ROOT/.runtime/supergateway"
patch_hash="$(cd "$ROOT/patches" && sha256sum supergateway-*.patch | sha256sum | awk '{print $1}')"
stamp="$REVISION $patch_hash"

if [ -d "$TARGET/node_modules/express" ] && [ -f "$TARGET/dist/index.js" ] \
  && [ "$(cat "$TARGET/.hibiscus-build" 2>/dev/null || true)" = "$stamp" ]; then
  exit 0
fi

command -v git >/dev/null 2>&1 || {
  echo 'git is required once to prepare the pinned Supergateway source.' >&2
  exit 1
}
NODE_BIN="${HIBISCUS_MCP_NODE:?HIBISCUS_MCP_NODE is required}"
export PATH="$(dirname "$NODE_BIN"):$PATH"
mkdir -p "$ROOT/.runtime"
tmp="$(mktemp -d "$ROOT/.runtime/.supergateway.XXXXXX")"
trap 'rm -rf -- "$tmp"' EXIT
git -C "$tmp" init -q
git -C "$tmp" remote add origin https://github.com/supercorp-ai/supergateway.git
git -C "$tmp" fetch -q --depth=1 origin "$REVISION"
git -C "$tmp" checkout -q --detach FETCH_HEAD
git -C "$tmp" apply --unidiff-zero --check "$ROOT/patches/supergateway-bearer.patch"
git -C "$tmp" apply --unidiff-zero "$ROOT/patches/supergateway-bearer.patch"
git -C "$tmp" apply --check "$ROOT/patches/supergateway-bind-host.patch"
git -C "$tmp" apply "$ROOT/patches/supergateway-bind-host.patch"
# Supergateway 4.1.0 already pins SDK 1.30.0; keep its upstream dependency lock.
npm --prefix "$tmp" ci
npm --prefix "$tmp" run build
"$NODE_BIN" "$ROOT/scripts/verify-supergateway.mjs" "$tmp" HIBISCUS_MCP_REQUEST_BEARER
npm --prefix "$tmp" prune --omit=dev
printf '%s\n' "$stamp" > "$tmp/.hibiscus-build"
rm -rf -- "$TARGET"
mv "$tmp" "$TARGET"
trap - EXIT
