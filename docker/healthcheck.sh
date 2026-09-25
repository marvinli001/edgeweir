#!/bin/sh
# Container health: the HTTP roles must answer /healthz; a pure worker has no
# listener, so only check that the process is alive.
set -eu
if [ "${ROLE:-all}" = "worker" ]; then
  exit 0
fi
wget -q -T 2 -O /dev/null "http://127.0.0.1:${PORT:-3000}/healthz"
