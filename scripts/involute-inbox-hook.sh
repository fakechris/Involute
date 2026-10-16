#!/usr/bin/env sh
# Claude Code UserPromptSubmit hook wrapper for Involute (INV-1247).
# Queries /mcp/readonly agent_inbox with a <=2s timeout and injects a 1-line
# additionalContext reminder when unread decisions exist; silent otherwise.
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec node "$SCRIPT_DIR/involute-inbox-hook.mjs" "$@"
