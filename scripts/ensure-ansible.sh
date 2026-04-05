#!/bin/sh

set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
VENV_DIR="$REPO_ROOT/.venv-ansible"
LOCK_DIR="$VENV_DIR.lock"

cleanup_lock() {
  rmdir "$LOCK_DIR" 2>/dev/null || true
}

if [ ! -x "$VENV_DIR/bin/ansible-playbook" ]; then
  while ! mkdir "$LOCK_DIR" 2>/dev/null; do
    if [ -x "$VENV_DIR/bin/ansible-playbook" ]; then
      break
    fi
    sleep 1
  done

  if [ ! -x "$VENV_DIR/bin/ansible-playbook" ]; then
    trap cleanup_lock EXIT INT TERM
    python3 -m venv "$VENV_DIR"
    "$VENV_DIR/bin/pip" install --quiet --upgrade pip >/dev/null
    "$VENV_DIR/bin/pip" install --quiet "ansible-core>=2.18,<2.20" >/dev/null
    cleanup_lock
    trap - EXIT INT TERM
  fi
fi

printf '%s\n' "$VENV_DIR/bin/ansible-playbook"
