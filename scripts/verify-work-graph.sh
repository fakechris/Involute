#!/usr/bin/env bash
# ==============================================================================
# scripts/verify-work-graph.sh
# Layer 1 Deterministic Engine Guardrail for Involute Work Graph
#
# Enforces that any commit modifying product source code must be explicitly
# bound to an Involute work item (e.g. INV-xxx in commit message or branch).
# ==============================================================================

set -euo pipefail

# 1. Determine commit message source
COMMIT_MSG_FILE="${1:-}"
INCOMING_MSG="${COMMIT_MSG:-}"

if [ -n "$COMMIT_MSG_FILE" ] && [ -f "$COMMIT_MSG_FILE" ]; then
  INCOMING_MSG="$(cat "$COMMIT_MSG_FILE")"
fi

CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)"

# 2. Inspect touched files
# In a commit-msg hook, staged files are what's being committed
STAGED_FILES="$(git diff --cached --name-only 2>/dev/null || true)"

# If no staged files (e.g. standalone check or post-commit), inspect working tree
if [ -z "$STAGED_FILES" ]; then
  STAGED_FILES="$(git status --porcelain 2>/dev/null | awk '{print $2}' || true)"
fi

# 3. Check for production code modifications
# Protected directories: packages/server/src and packages/web/src (excluding tests)
PROTECTED_CHANGES=""
if [ -n "$STAGED_FILES" ]; then
  PROTECTED_CHANGES="$(echo "$STAGED_FILES" | grep -E '^packages/(server|web)/src/' | grep -v -E '\.(test|spec)\.(ts|tsx)$' || true)"
fi

# If no protected files are modified, pass immediately
if [ -z "$PROTECTED_CHANGES" ]; then
  echo "[Involute Guardrail] No protected production source code changed. Check passed."
  exit 0
fi

# 4. Validate presence of Involute identifier (INV-xxx)
INV_PATTERN='(INV|inv)-[0-9]+'
FOUND_IN_MSG=false
FOUND_IN_BRANCH=false

if [ -n "$INCOMING_MSG" ] && echo "$INCOMING_MSG" | grep -qE "$INV_PATTERN"; then
  FOUND_IN_MSG=true
fi

# If branch is not a generic branch like main, master, staging, check if it has INV-xxx
if [ "$CURRENT_BRANCH" != "main" ] && [ "$CURRENT_BRANCH" != "master" ] && [ "$CURRENT_BRANCH" != "staging" ] && [ "$CURRENT_BRANCH" != "dev" ]; then
  if echo "$CURRENT_BRANCH" | grep -qE "$INV_PATTERN"; then
    FOUND_IN_BRANCH=true
  fi
fi

if [ "$FOUND_IN_MSG" = true ] || [ "$FOUND_IN_BRANCH" = true ]; then
  MATCHED_ID="$(echo "${INCOMING_MSG} ${CURRENT_BRANCH}" | grep -oE "$INV_PATTERN" | head -n 1 | tr '[:lower:]' '[:upper:]')"
  echo "================================================================================"
  echo " [Involute Guardrail] OK: Verified commit linked to ${MATCHED_ID}"
  echo "================================================================================"
  exit 0
fi

# 5. Intercept unlinked production code commit with actionable error message
echo ""
echo "================================================================================"
echo " [INVOLUTE GUARDRAIL VIOLATION] Unlinked Production Code Modification Detected!"
echo "================================================================================"
echo " You are attempting to commit modifications to core product source code:"
echo ""
echo "$PROTECTED_CHANGES" | sed 's/^/   • /'
echo ""
echo " [RULE: No Ghost Fixes / 严禁幽灵代码]"
echo " According to Involute Agent Architecture, all production source code changes"
echo " MUST be atomically bound to an Involute Work Item (e.g. INV-xxx)."
echo ""
echo " HOW TO RESOLVE:"
echo ""
echo " 1. For Planned Features & Issues:"
echo "    Include the work item identifier in your commit message:"
echo "      git commit -m \"feat(kernel): [INV-xxx] your message\""
echo "    Or work on an issue branch:"
echo "      git checkout -b feat/INV-xxx-description"
echo ""
echo " 2. For Unplanned Work & Hotfixes (动量优先反射弧):"
echo "    Run the automatic hotfix reflex script to propose & link in one step:"
echo "      pnpm hotfix:reflex --title \"Describe the fix\" --parent <PARENT_INV>"
echo ""
echo "================================================================================"
echo ""
exit 1
