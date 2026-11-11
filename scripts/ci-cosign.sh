#!/usr/bin/env bash
set -euo pipefail

# Match cosign-installer v4.1.0's pinned bootstrap and keyless/KMS verification.
cosign_dir="$RUNNER_TEMP/edgeweir-cosign"
mkdir -p "$cosign_dir"
# Release assets come through the API: with GH_TOKEN (the job token) it does
# not hit the unauthenticated rate limit that parallel jobs on shared runner
# addresses share (curl drops the header on the redirect to the asset host).
auth=()
[[ -z "${GH_TOKEN:-}" ]] || auth=(-H "Authorization: Bearer $GH_TOKEN")
download_asset() {
  curl -fsSL --retry 3 --connect-timeout 15 --max-time 180 "${auth[@]}" \
    -H 'Accept: application/octet-stream' \
    "https://api.github.com/repos/sigstore/cosign/releases/assets/$1" \
    -o "$cosign_dir/$2"
}
download_asset 358750885 bootstrap
download_asset 503286005 cosign
download_asset 503286953 keyless.sigstore.json
download_asset 503286884 kms.sigstore.json
curl -fsSL --retry 3 --connect-timeout 15 --max-time 180 \
  https://raw.githubusercontent.com/sigstore/cosign/v3.1.3/release/release-cosign.pub \
  -o "$cosign_dir/public.key"
printf '%s\n' \
  'db15cc99e6e4837daabab023742aaddc3841ce57f193d11b7c3e06c8003642b2  bootstrap' \
  '4629c757b7618056f8ddd7e2625ae9fdd94c0372a65049520bc7d9df9efc7f71  cosign' \
  'f4cea466e5e887a45da5031757fa1d32655d83420639dc1758749b744179f126  public.key' \
  | (cd "$cosign_dir" && sha256sum -c -)
chmod +x "$cosign_dir/bootstrap"
"$cosign_dir/bootstrap" verify-blob \
  --certificate-identity keyless@projectsigstore.iam.gserviceaccount.com \
  --certificate-oidc-issuer https://accounts.google.com \
  --bundle "$cosign_dir/keyless.sigstore.json" "$cosign_dir/cosign"
"$cosign_dir/bootstrap" verify-blob --key "$cosign_dir/public.key" \
  --bundle "$cosign_dir/kms.sigstore.json" "$cosign_dir/cosign"
chmod +x "$cosign_dir/cosign"
"$cosign_dir/cosign" version
rm "$cosign_dir/bootstrap" "$cosign_dir/keyless.sigstore.json" "$cosign_dir/kms.sigstore.json" "$cosign_dir/public.key"
echo "$cosign_dir" >> "$GITHUB_PATH"
