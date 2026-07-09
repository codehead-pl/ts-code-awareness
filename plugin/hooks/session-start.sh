#!/usr/bin/env bash
# SessionStart hook: ensure the shared tsca daemon is running.
# Idempotent — safe to run on every session; a health check short-circuits when
# the daemon is already up (it outlives individual sessions).
set -euo pipefail

PORT="${TSCA_PORT:-47600}"
if curl -sf "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
  exit 0
fi

# Resolve the repo root: prefer Claude Code's env var, else derive from this file.
REPO="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
export TSCA_CACHE_DIR="${TSCA_CACHE_DIR:-$REPO/.tsca-cache}"

nohup npx tsx "$REPO/packages/daemon/src/index.ts" \
  >"${TMPDIR:-/tmp}/tsca-daemon.log" 2>&1 &

# Wait briefly for the port to bind so the first tool call doesn't race the boot.
for _ in $(seq 1 20); do
  curl -sf "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1 && break
  sleep 0.25
done
exit 0
