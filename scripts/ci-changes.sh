#!/usr/bin/env bash
set -euo pipefail

base=${1:?base commit required}
head=${2:-HEAD}
if [[ "$base" =~ ^0+$ ]]; then
  echo true
  exit 0
fi
if ! git cat-file -e "$base^{commit}" 2>/dev/null; then
  git fetch --no-tags --depth=1 origin "$base" >&2 || { echo true; exit 0; }
fi
changes=$(git -c core.quotepath=false diff --no-renames --name-only "$base" "$head")
while IFS= read -r path; do
  [[ -n "$path" ]] || continue
  case "$path" in
    doc/*|docs/*|.github/assets/*|.github/workflows/docs.yml) continue ;;
  esac
  if [[ "$path" != */* && "$path" == *.md ]]; then continue; fi
  echo true
  exit 0
done <<<"$changes"
echo false
