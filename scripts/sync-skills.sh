#!/usr/bin/env bash
# ==============================================================================
# scripts/sync-skills.sh
# Synchronizes Involute skills from repository to global agent skill directories
# across local machine (macOS) and remote host (VPS / Box)
# ==============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SOURCE_SKILLS="$REPO_DIR/skills"

echo "=== Synchronizing Involute Skills ==="
echo "Source: $SOURCE_SKILLS"

# ------------------------------------------------------------------------------
# 1. Local Agent Skill Directories (macOS)
# ------------------------------------------------------------------------------
LOCAL_TARGETS=(
  "$HOME/.skills"
  "$HOME/.gemini/config/skills"
  "$HOME/.cursor/skills"
  "$HOME/.config/opencode/skills"
  "$HOME/.grok/skills"
  "$HOME/.factory/skills"
  "$HOME/.zcode/skills"
  "$HOME/.pi/agent/skills"
)

echo ""
echo "--- Local Agent Environments ---"
for target_base in "${LOCAL_TARGETS[@]}"; do
  if [ -d "$target_base" ] || [ -L "$target_base" ]; then
    echo "Syncing to: $target_base"
    for skill_dir in "$SOURCE_SKILLS"/*; do
      if [ -d "$skill_dir" ]; then
        skill_name="$(basename "$skill_dir")"
        mkdir -p "$target_base/$skill_name"
        cp -R "$skill_dir/"* "$target_base/$skill_name/"
      fi
    done
    echo "  ✓ Successfully synced skills to $target_base"
  else
    echo "  ! Skipping $target_base (directory not found)"
  fi
done

# ------------------------------------------------------------------------------
# 2. Remote Agent Skill Directories (VPS / Box: 100.114.30.43)
# ------------------------------------------------------------------------------
REMOTE_HOST="${INVOLUTE_VPS_HOST:-box@100.114.30.43}"
REMOTE_TARGETS=(
  "/home/box/.agents/skills"
  "/home/box/.cursor/skills-cursor"
  "/home/box/.pi/agent/skills"
  "/home/box/work/skills"
  "/workspace/Involute/skills"
)

echo ""
echo "--- Remote VPS Environments ($REMOTE_HOST) ---"
if ssh -o BatchMode=yes -o ConnectTimeout=3 "$REMOTE_HOST" "true" 2>/dev/null; then
  for remote_target in "${REMOTE_TARGETS[@]}"; do
    echo "Syncing to remote: $REMOTE_HOST:$remote_target"
    COPYFILE_DISABLE=1 tar --no-xattrs -C "$SOURCE_SKILLS" -cf - . | \
      ssh -o BatchMode=yes -o ConnectTimeout=5 "$REMOTE_HOST" \
        "mkdir -p '$remote_target' && tar -C '$remote_target' -xf -"
    echo "  ✓ Synced to $REMOTE_HOST:$remote_target"
  done

  # Also sync root AGENTS.md to /workspace/Involute/AGENTS.md if present
  if ssh -o BatchMode=yes -o ConnectTimeout=3 "$REMOTE_HOST" "[ -d /workspace/Involute ]" 2>/dev/null; then
    echo "Syncing AGENTS.md to remote /workspace/Involute/AGENTS.md"
    scp -q -o BatchMode=yes -o ConnectTimeout=5 "$REPO_DIR/AGENTS.md" "$REMOTE_HOST:/workspace/Involute/AGENTS.md"
    echo "  ✓ Synced AGENTS.md to remote /workspace/Involute"
  fi
else
  echo "  ! Could not reach remote host $REMOTE_HOST (offline or SSH unavailable); skipped remote sync"
fi

echo ""
echo "=== Skill Synchronization Complete ==="
