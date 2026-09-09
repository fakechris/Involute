#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
git config core.hooksPath .githooks
chmod +x "$ROOT_DIR/.githooks/commit-msg"
chmod +x "$ROOT_DIR/scripts/verify-work-graph.sh"
echo "[Involute] Git guardrail hooks successfully installed in .githooks"
