#!/usr/bin/env bash
# ==============================================================================
# scripts/verify-work-graph.sh
# Offline wrapper for PR work graph verification.
# Zero network calls, completely safe for offline development and CI.
# ==============================================================================

set -euo pipefail
ROOT_DIR="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"

if [ -f "$ROOT_DIR/scripts/ci-pr-lint.sh" ]; then
  exec "$ROOT_DIR/scripts/ci-pr-lint.sh"
fi

exit 0
