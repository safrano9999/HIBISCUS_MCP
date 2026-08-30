#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="${HIBISCUS_MCP_NODE_VERSION:-24.18.1}"

usable() {
  "$1" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' \
    >/dev/null 2>&1
}

global_node="$(command -v node || true)"
if [ -n "$global_node" ] && command -v npm >/dev/null 2>&1 && usable "$global_node"; then
  printf '%s\n' "$global_node"
  exit 0
fi

case "$(uname -m)" in
  x86_64|amd64) arch=x64 ;;
  aarch64|arm64) arch=arm64 ;;
  *) echo "Unsupported Node.js architecture: $(uname -m)" >&2; exit 1 ;;
esac

runtime="$ROOT/.runtime"
install="$runtime/node-v${VERSION}-linux-${arch}"
node="$install/bin/node"
if [ ! -x "$node" ] || ! usable "$node"; then
  mkdir -p "$runtime"
  tmp="$(mktemp -d "$runtime/.node.XXXXXX")"
  trap 'rm -rf -- "$tmp"' EXIT
  archive="node-v${VERSION}-linux-${arch}.tar.xz"
  base="https://nodejs.org/dist/v${VERSION}"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSLo "$tmp/$archive" "$base/$archive"
    curl -fsSLo "$tmp/SHASUMS256.txt" "$base/SHASUMS256.txt"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$tmp/$archive" "$base/$archive"
    wget -qO "$tmp/SHASUMS256.txt" "$base/SHASUMS256.txt"
  else
    echo 'Node.js is missing and neither curl nor wget is available.' >&2
    exit 1
  fi
  expected="$(awk -v file="$archive" '$2 == file { print $1; exit }' "$tmp/SHASUMS256.txt")"
  actual="$(sha256sum "$tmp/$archive" | awk '{print $1}')"
  [ -n "$expected" ] && [ "$actual" = "$expected" ] || {
    echo 'Node.js archive checksum mismatch.' >&2
    exit 1
  }
  tar -xJf "$tmp/$archive" -C "$tmp"
  rm -rf -- "$install"
  mv "$tmp/node-v${VERSION}-linux-${arch}" "$install"
fi

printf '%s\n' "$node"
