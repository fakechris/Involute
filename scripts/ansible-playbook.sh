#!/bin/sh

set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
PLAYBOOK=${1:?Usage: sh scripts/ansible-playbook.sh <playbook> [args...]}
shift

if [ "${1:-}" = "--" ]; then
  shift
fi

ANSIBLE_PLAYBOOK=$(sh "$SCRIPT_DIR/ensure-ansible.sh")
export ANSIBLE_CONFIG="$REPO_ROOT/ops/ansible/ansible.cfg"
STACK_PROFILE=${INVOLUTE_STACK_PROFILE:-}

if [ -n "$STACK_PROFILE" ]; then
  exec "$ANSIBLE_PLAYBOOK" -e "involute_stack_profile=$STACK_PROFILE" "$PLAYBOOK" "$@"
fi

exec "$ANSIBLE_PLAYBOOK" "$PLAYBOOK" "$@"
