#!/usr/bin/env bash
# ==============================================================================
# scripts/ci-pr-lint.sh
# Pure offline PR regex linter for GitHub Actions CI.
# Zero network calls, zero external database dependencies.
# ==============================================================================

set -euo pipefail

PR_TITLE="${PR_TITLE:-}"
PR_BRANCH="${PR_BRANCH:-$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)}"

# Supported team key patterns across repositories (e.g. INV, LUM)
PATTERN='(^|[^A-Za-z])(INV|inv|LUM|lum)-[0-9]+'

# Main or release branches directly pushed do not require PR lint
if [ "$PR_BRANCH" = "main" ] || [ "$PR_BRANCH" = "master" ]; then
  echo "[Involute CI Lint] Skipping PR lint on base branch: $PR_BRANCH"
  exit 0
fi

if echo "$PR_TITLE $PR_BRANCH" | grep -qE "$PATTERN"; then
  MATCHED="$(echo "$PR_TITLE $PR_BRANCH" | grep -oE '(INV|inv|LUM|lum)-[0-9]+' | head -n 1 | tr '[:lower:]' '[:upper:]')"
  echo "✓ [Involute CI Lint] Verified work item reference: ${MATCHED}"
  exit 0
fi

echo ""
echo "================================================================================"
echo "::error::[Involute CI Lint] Pull Request must reference a valid work item!"
echo "================================================================================"
echo " Branch: $PR_BRANCH"
echo " Title:  $PR_TITLE"
echo ""
echo " Involute follows the Branch-First Convention (Convention over Ceremony):"
echo "   • Work branch name: feat/INV-xxx-description or fix/INV-xxx-description"
echo "   • Or PR title:      feat: [INV-xxx] description"
echo "================================================================================"
echo ""
exit 1
