#!/bin/bash
# SessionStart hook: prepares a Claude Code cloud session (Node 24, pnpm, dependencies).
# Local sessions exit immediately; remote sessions use the repository toolchain.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-$(dirname "$0")/..}"

NODE_MAJOR="$(tr -d '[:space:]' < .nvmrc)"
[[ "$NODE_MAJOR" =~ ^[0-9]+$ ]] || { echo '.nvmrc must name a Node major' >&2; exit 1; }
NODE_DIR="${HOME}/.local/node${NODE_MAJOR}"
PNPM_VERSION="$(sed -n 's/.*"packageManager": "pnpm@\([^"]*\)".*/\1/p' package.json)"
[[ "$PNPM_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo 'missing pinned pnpm version' >&2; exit 1; }
[[ "$(uname -s)" == Linux ]] || { echo 'remote bootstrap requires Linux' >&2; exit 1; }

compatible_node() {
  "$1" -e 'const p=process.versions.node.split(".").map(Number); const min=JSON.parse(require("fs").readFileSync("package.json","utf8")).engines.node.match(/^>=(\d+)\.(\d+)\.(\d+)$/); if (!min) process.exit(1); const need=min.slice(1).map(Number); process.exit(p[0]===Number(process.argv[1]) && (p[0]>need[0] || p[1]>need[1] || (p[1]===need[1] && p[2]>=need[2])) ? 0 : 1)' "$NODE_MAJOR" 2>/dev/null
}

if ! compatible_node "${NODE_DIR}/bin/node"; then
  case "$(uname -m)" in
    x86_64) arch=x64 ;;
    aarch64 | arm64) arch=arm64 ;;
    *) echo "unsupported arch $(uname -m)" >&2; exit 1 ;;
  esac
  base="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x"
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  curl -fsSL --retry 3 "${base}/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt"
  tarball="$(awk -v arch="$arch" '$2 ~ ("^node-v[0-9.]+-linux-" arch "\\.tar\\.xz$") {print $2}' "$tmp/SHASUMS256.txt")"
  [[ "$tarball" =~ ^node-v[0-9.]+-linux-(x64|arm64)\.tar\.xz$ ]] || { echo 'invalid Node release manifest' >&2; exit 1; }
  release="${tarball#node-}"; release="${release%-linux-*}"
  curl -fsSL --retry 3 "https://nodejs.org/dist/${release}/${tarball}" -o "${tmp}/${tarball}"
  (cd "$tmp" && awk -v file="$tarball" '$2 == file' SHASUMS256.txt | sha256sum -c -)
  mkdir -p "$tmp/node"
  tar -xJf "${tmp}/${tarball}" -C "$tmp/node" --strip-components=1
  compatible_node "$tmp/node/bin/node" || { echo 'downloaded Node does not satisfy package.json' >&2; exit 1; }
  mkdir -p "$(dirname "$NODE_DIR")"
  rm -rf "$NODE_DIR"
  mv "$tmp/node" "$NODE_DIR"
fi

export PATH="${NODE_DIR}/bin:${PATH}"
if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  printf 'export PATH=%q:"$PATH"\n' "${NODE_DIR}/bin" >> "$CLAUDE_ENV_FILE"
fi

if [ "$(pnpm --version 2>/dev/null)" != "$PNPM_VERSION" ]; then
  npm install --prefix "$NODE_DIR" -g --silent "pnpm@${PNPM_VERSION}"
fi

pnpm install --frozen-lockfile
