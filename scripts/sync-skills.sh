#!/usr/bin/env bash
# ==============================================================================
# scripts/sync-skills.sh
# Synchronizes Involute skills from repository to global agent skill directories
# ==============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SOURCE_SKILLS="$REPO_DIR/skills"

GLOBAL_SKILLS="/Users/chris/.skills"
GEMINI_SKILLS="/Users/chris/.gemini/config/skills"

echo "=== Synchronizing Involute Skills ==="
echo "Source: $SOURCE_SKILLS"

# 1. Sync to global skills directory (/Users/chris/.skills)
if [ -d "$GLOBAL_SKILLS" ]; then
  echo "Target: $GLOBAL_SKILLS (Global Agent Skills Hub)"
  for skill_dir in "$SOURCE_SKILLS"/*; do
    if [ -d "$skill_dir" ]; then
      skill_name="$(basename "$skill_dir")"
      mkdir -p "$GLOBAL_SKILLS/$skill_name"
      cp -R "$skill_dir/"* "$GLOBAL_SKILLS/$skill_name/"
      echo "  ✓ Synced $skill_name -> $GLOBAL_SKILLS/$skill_name"
    fi
  done
else
  echo "  ! Skipping $GLOBAL_SKILLS (directory not found)"
fi

# 2. Sync to Gemini/Antigravity skills directory
if [ -d "$GEMINI_SKILLS" ]; then
  echo "Target: $GEMINI_SKILLS (Gemini / Antigravity Skills)"
  for skill_dir in "$SOURCE_SKILLS"/*; do
    if [ -d "$skill_dir" ]; then
      skill_name="$(basename "$skill_dir")"
      mkdir -p "$GEMINI_SKILLS/$skill_name"
      cp -R "$skill_dir/"* "$GEMINI_SKILLS/$skill_name/"
      echo "  ✓ Synced $skill_name -> $GEMINI_SKILLS/$skill_name"
    fi
  done
else
  echo "  ! Skipping $GEMINI_SKILLS (directory not found)"
fi

echo ""
echo "=== Skill Synchronization Complete ==="
