#!/bin/sh
# Wire compatibility of proto/ with the newest proto/vX.Y.Z tag (buf breaking,
# FILE rules from proto/buf.yaml). A change it rejects needs a new major version
# of proto and of edgeweir-node.
#   scripts/proto-breaking.sh                  # tags of this clone
#   PROTO_REMOTE=<git URL> scripts/proto-breaking.sh   # tags of a remote (CI)
set -eu
cd "$(dirname "$0")/.."
if [ -n "${PROTO_REMOTE:-}" ]; then
  tag=$(git ls-remote --sort=-v:refname --tags --refs "$PROTO_REMOTE" 'proto/v*' | sed -n '1s|.*refs/tags/||p')
  base=$PROTO_REMOTE
else
  tag=$(git tag --list 'proto/v*' --sort=-v:refname | head -n 1)
  base=$(git rev-parse --path-format=absolute --git-common-dir)
fi
if [ -z "$tag" ]; then
  echo "no proto/v* tag found" >&2
  exit 1
fi
echo "buf breaking proto against $tag"
exec buf breaking proto --against "$base#tag=$tag,subdir=proto"
