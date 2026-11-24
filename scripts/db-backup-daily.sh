#!/usr/bin/env bash
# Daily verified Postgres backup for production (run as root on the box).
#
#   sudo bash scripts/db-backup-daily.sh            # take, verify and prune
#   sudo bash scripts/db-backup-daily.sh install    # install the daily systemd timer
#
# Install from a file on the box, never through stdin (INV-2152): with
# `bash -s install < db-backup-daily.sh` the script cannot find itself, and
# could copy whatever file called "bash" sits in the current directory.
#   scp scripts/db-backup-daily.sh oracle_5:/tmp/ && ssh oracle_5 'sudo bash /tmp/db-backup-daily.sh install'
#
# involute-db-backup-script (marker: the installer checks it copies this file)
#
# Each run:
#   1. pg_dump -Fc from the db container into a temp file;
#   2. verifies it: pg_restore --list must read it and list table data, and the
#      dump must not be much smaller than the previous one (MIN_SIZE_RATIO);
#   3. moves it into $BACKUP_DIR with a .sha256 next to it;
#   4. only after a verified dump, prunes to a tiered set (see below): 5-7
#      dumps, roughly 1, 2, 3, 7, 30 and 60 days old.
# A failed run exits non-zero, deletes nothing and leaves the last good set.
# Pre-deploy dumps (deploy-prod.sh, .backups/involute-*.dump) are separate.
set -euo pipefail

INVOLUTE_DIR="${INVOLUTE_DIR:-/opt/involute}"
BACKUP_DIR="${BACKUP_DIR:-$INVOLUTE_DIR/.backups/daily}"
KEEP_DAILY="${KEEP_DAILY:-3}"
MIN_SIZE_RATIO="${MIN_SIZE_RATIO:-50}" # percent of the previous dump
DB_USER="${DB_USER:-involute}"
DB_NAME="${DB_NAME:-involute}"

log() { echo "db-backup: $*"; }
fail() { echo "db-backup: FAILED: $*" >&2; exit 1; }

if [[ "${1:-}" == "install" ]]; then
  # The file being run, not $0: under `bash -s` that is just "bash" (INV-2152).
  script="${BASH_SOURCE[0]:-}"
  if [[ -z "$script" || ! -f "$script" ]] || ! grep -q '^# involute-db-backup-script' "$script"; then
    fail "install must run from the script file, not from stdin. Copy it to the box and run it by path: scp scripts/db-backup-daily.sh oracle_5:/tmp/ && ssh oracle_5 'sudo bash /tmp/db-backup-daily.sh install'"
  fi
  script="$(readlink -f "$script")"
  install -m 0755 "$script" /usr/local/sbin/involute-db-backup
  cat > /etc/systemd/system/involute-db-backup.service <<EOF
[Unit]
Description=Involute daily verified Postgres backup
After=docker.service

[Service]
Type=oneshot
Environment=INVOLUTE_DIR=$INVOLUTE_DIR
ExecStart=/usr/local/sbin/involute-db-backup
EOF
  cat > /etc/systemd/system/involute-db-backup.timer <<'EOF'
[Unit]
Description=Run the Involute Postgres backup daily

[Timer]
OnCalendar=*-*-* 19:30:00 UTC
Persistent=true
RandomizedDelaySec=10m

[Install]
WantedBy=timers.target
EOF
  systemctl daemon-reload
  systemctl enable --now involute-db-backup.timer
  systemctl list-timers involute-db-backup.timer --no-pager
  exit 0
fi

cd "$INVOLUTE_DIR"
DB_CONTAINER="$(docker ps --filter 'label=com.docker.compose.service=db' --format '{{.Names}}' | head -1)"
[[ -n "$DB_CONTAINER" ]] || fail "no running db container"
mkdir -p "$BACKUP_DIR"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
NAME="involute-${STAMP}.dump"
TMP="$(mktemp "$BACKUP_DIR/.${NAME}.XXXXXX")"
trap 'rm -f "$TMP"' EXIT

docker exec "$DB_CONTAINER" pg_dump -U "$DB_USER" -d "$DB_NAME" -Fc > "$TMP" || fail "pg_dump exited $?"

# Verify: the archive is readable and carries table data.
TABLES="$(docker exec -i "$DB_CONTAINER" pg_restore --list < "$TMP" | grep -c ' TABLE DATA ' || true)"
[[ "$TABLES" -gt 0 ]] || fail "pg_restore --list found no table data in the dump"
SIZE="$(stat -c %s "$TMP")"
PREV="$(ls -1t "$BACKUP_DIR"/involute-*.dump 2>/dev/null | head -1 || true)"
if [[ -n "$PREV" ]]; then
  PREV_SIZE="$(stat -c %s "$PREV")"
  if (( SIZE * 100 < PREV_SIZE * MIN_SIZE_RATIO )); then
    mv "$TMP" "$BACKUP_DIR/.suspect-${NAME}"
    fail "dump is ${SIZE} bytes, under ${MIN_SIZE_RATIO}% of the previous ${PREV_SIZE}; kept as .suspect-${NAME}, nothing pruned"
  fi
fi

mv "$TMP" "$BACKUP_DIR/$NAME"
trap - EXIT
(cd "$BACKUP_DIR" && sha256sum "$NAME" > "$NAME.sha256")
log "wrote $BACKUP_DIR/$NAME (${SIZE} bytes, ${TABLES} tables of data)"

# Tiered retention, only after a verified dump (grandfather-father-son):
# the KEEP_DAILY newest, the oldest of this and last ISO week, the oldest of
# this and last month. Taken daily that is 5-7 dumps, roughly 1, 2, 3, ~7,
# ~30 and 28-60 days old. Dates come from the file names (UTC).
declare -A keep=()
mapfile -t dumps < <(ls -1 "$BACKUP_DIR"/involute-*.dump | sort -r) # newest first
for f in "${dumps[@]:0:$KEEP_DAILY}"; do keep["$f"]=1; done
day_of() { local b; b="$(basename "$1")"; echo "${b:9:8}"; } # involute-YYYYMMDD...
declare -A oldest_week=() oldest_month=()
for f in "${dumps[@]}"; do # newest first, so the last write per key is the oldest
  d="$(day_of "$f")"
  oldest_week["$(date -u -d "$d" +%G%V)"]="$f"
  oldest_month["${d:0:6}"]="$f"
done
for k in $(printf '%s\n' "${!oldest_week[@]}" | sort -r | head -2); do keep["${oldest_week[$k]}"]=1; done
for k in $(printf '%s\n' "${!oldest_month[@]}" | sort -r | head -2); do keep["${oldest_month[$k]}"]=1; done
for f in "${dumps[@]}"; do
  if [[ -z "${keep[$f]:-}" ]]; then
    rm -f "$f" "$f.sha256"
    log "pruned $(basename "$f")"
  fi
done
log "keeping ${#keep[@]}: $(for f in "${!keep[@]}"; do basename "$f"; done | sort | tr '\n' ' ')"
