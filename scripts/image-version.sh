#!/bin/sh
# Rolling image version of a commit: <UTC commit date YYYYMMDD>-<first 7 hex of the commit>.
# The same commit always yields the same version; there are no release tags.
#   scripts/image-version.sh           # HEAD
#   scripts/image-version.sh <commit>
set -eu
commit=$(git rev-parse --verify "${1:-HEAD}^{commit}")
date=$(TZ=UTC0 git log -1 --format=%cd --date=format-local:%Y%m%d "$commit")
printf '%s-%s\n' "$date" "$(printf '%s' "$commit" | cut -c1-7)"
