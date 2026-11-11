#!/usr/bin/env bash
# Installs the verified Syft 1.52.0 (linux amd64) for the e2e fixtures:
# `make openresty-packages` writes the packages' SBOM, goreleaser the others.
set -euo pipefail
syft_dir="$RUNNER_TEMP/syft"
mkdir -p "$syft_dir"
# Release assets come through the API: with GH_TOKEN (the job token) it does
# not hit the unauthenticated rate limit that parallel jobs on shared runner
# addresses share (curl drops the header on the redirect to the asset host).
auth=()
[[ -z "${GH_TOKEN:-}" ]] || auth=(-H "Authorization: Bearer $GH_TOKEN")
curl -fsSL --retry 3 --connect-timeout 15 --max-time 180 "${auth[@]}" \
  -H 'Accept: application/octet-stream' \
  https://api.github.com/repos/anchore/syft/releases/assets/570445809 \
  -o "$syft_dir/syft.tar.gz"
printf '%s  %s\n' caeedb81fb0491615f1ebd1761e4145d41ee86dd2cc7bf80669f9f5ad9d6133d "$syft_dir/syft.tar.gz" | sha256sum -c -
tar -xzf "$syft_dir/syft.tar.gz" -C "$syft_dir" syft
"$syft_dir/syft" version
echo "$syft_dir" >> "$GITHUB_PATH"
