#!/usr/bin/env bash
# Waits until this run's "build image" job has uploaded the candidate-image
# artifact (its "Upload the candidate image" step passed), so an e2e shard can
# prepare while the image builds. Fails when that job ends without it.
# Needs gh with GH_TOKEN (actions: read), GITHUB_REPOSITORY and GITHUB_RUN_ID.
set -euo pipefail

jobs_url="repos/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID/jobs?filter=latest&per_page=100"
filter='[.jobs[] | select(.name == "build image")][0] // {} |
  if .conclusion == "success" or any(.steps[]?; .name == "Upload the candidate image" and .conclusion == "success") then "ready"
  elif .status == "completed" then "failed: \(.conclusion)"
  else "waiting (\(.status // "not listed"))" end'
started=$SECONDS last=""
while :; do
  state="$(gh api "$jobs_url" --jq "$filter" 2>&1)" || state="waiting (API: ${state//$'\n'/ })"
  case "$state" in
    ready) echo "candidate image ready after $((SECONDS - started)) s"; exit 0 ;;
    failed:*) echo "the build image job ended without the candidate ($state)" >&2; exit 1 ;;
  esac
  [[ "$state" == "$last" ]] || echo "$state"
  last="$state"
  sleep 10
done
