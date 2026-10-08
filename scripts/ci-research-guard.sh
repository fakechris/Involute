#!/usr/bin/env bash
# Research isolation guard (AGENTS.md §4.7, INV-1003). Competitive notes,
# exports and research reports live in research/ and are shared through
# Involute attachments (work_attach_file) — never through git or a Docker
# image. Fails when any research/ path is tracked, or when .gitignore /
# .dockerignore stop excluding it.
set -euo pipefail
cd "$(dirname "$0")/.."
status=0
tracked="$(git ls-files -- 'research/**' 'research/*' '*/research/**' 2>/dev/null || true)"
if [[ -n "$tracked" ]]; then
  echo "research/ files are tracked by git (AGENTS.md §4.7 forbids this; attach them to the work with work_attach_file instead):" >&2
  echo "$tracked" | sed 's/^/  /' >&2
  status=1
fi
grep -qE '^research/?$' .gitignore || { echo ".gitignore no longer ignores research/" >&2; status=1; }
grep -qE '^research/?$' .dockerignore || { echo ".dockerignore no longer excludes research/ from images" >&2; status=1; }
[[ $status -eq 0 ]] && echo "research guard: nothing from research/ is tracked or shipped"
exit $status
