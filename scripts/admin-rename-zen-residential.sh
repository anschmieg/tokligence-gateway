#!/usr/bin/env bash
# User-authorized host-side migration: zen-residential.service -> residential-vpn.service
# This script is intentionally NOT invoked by the repository or over SSH.
set -Eeuo pipefail

readonly OLD_UNIT=/etc/systemd/system/zen-residential.service
readonly NEW_UNIT=/etc/systemd/system/residential-vpn.service
readonly EXPECTED_SHA256=41adf5ca2cd7a1f9fdd91b340baa435646b7b65a2469b0970c7bbd02f07444e7
readonly EXPECTED_OLD_ALIAS=/etc/systemd/system/zen-residential.service
readonly BACKUP_DIR=/var/backups/systemd-unit-renames
readonly OLD_NAME=zen-residential.service
readonly NEW_NAME=residential-vpn.service

backup=''
transaction_started=0
committed=0
was_active=0
was_enabled=0

log() { printf '[rename-unit] %s\n' "$*"; }
fatal() { log "ERROR: $*" >&2; exit 1; }

rollback() {
  local rc=$?
  trap - ERR INT TERM
  if (( transaction_started && ! committed )); then
    log 'Attempting rollback to the original unit.'
    set +e
    systemctl stop "$NEW_NAME" >/dev/null 2>&1
    if [[ -L "$OLD_UNIT" && "$(readlink -f -- "$OLD_UNIT")" == "$NEW_UNIT" ]]; then
      rm -- "$OLD_UNIT"
    fi
    if [[ -f "$NEW_UNIT" && -n "$backup" && -f "$backup" ]]; then
      cp -a -- "$backup" "$OLD_UNIT"
      rm -- "$NEW_UNIT"
    elif [[ ! -e "$OLD_UNIT" && -n "$backup" && -f "$backup" ]]; then
      cp -a -- "$backup" "$OLD_UNIT"
    fi
    systemctl daemon-reload
    if (( was_active )); then systemctl start "$OLD_NAME"; fi
    set -e
    log 'Rollback commands completed; inspect systemctl status before relying on service health.'
  fi
  exit "$rc"
}
trap rollback EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

[[ $EUID -eq 0 ]] || fatal 'Run this script as root on the target host after authorization.'
command -v systemctl >/dev/null || fatal 'systemctl is unavailable.'
[[ -f "$OLD_UNIT" && ! -L "$OLD_UNIT" ]] || fatal "Expected regular source unit at $OLD_UNIT. Nothing changed."
[[ ! -e "$NEW_UNIT" && ! -L "$NEW_UNIT" ]] || fatal "Destination already exists; refusing to overwrite $NEW_UNIT. Nothing changed."
[[ ! -e "$EXPECTED_OLD_ALIAS" || ! -L "$EXPECTED_OLD_ALIAS" ]] || fatal 'Old unit path is not the expected regular file.'

actual_hash=$(sha256sum -- "$OLD_UNIT" | awk '{print $1}')
[[ "$actual_hash" == "$EXPECTED_SHA256" ]] || fatal "Source unit hash changed (got $actual_hash); re-inspect before proceeding."

# Avoid replacing any unit that has local drop-ins or an unexpected loaded fragment.
fragment=$(systemctl show "$OLD_NAME" -p FragmentPath --value)
[[ "$fragment" == "$OLD_UNIT" ]] || fatal "Loaded fragment differs from expected source: $fragment"
dropins=$(systemctl show "$OLD_NAME" -p DropInPaths --value)
[[ -z "$dropins" ]] || fatal "Source has drop-ins ($dropins); re-assess before proceeding."

active_state=$(systemctl is-active "$OLD_NAME" 2>/dev/null || true)
case "$active_state" in
  active) was_active=1 ;;
  inactive) was_active=0 ;;
  *) fatal "Unexpected source active state '$active_state'; refusing migration." ;;
esac
enabled_state=$(systemctl is-enabled "$OLD_NAME" 2>/dev/null || true)
case "$enabled_state" in
  disabled) was_enabled=0 ;;
  enabled) was_enabled=1 ;;
  *) fatal "Unexpected source enablement '$enabled_state'; refusing to change enablement." ;;
esac

install -d -o root -g root -m 0700 "$BACKUP_DIR"
backup="$BACKUP_DIR/${OLD_NAME}.$(date -u +%Y%m%dT%H%M%SZ).bak"
[[ ! -e "$backup" ]] || fatal "Backup path already exists: $backup"
cp -a -- "$OLD_UNIT" "$backup"
[[ "$(sha256sum -- "$backup" | awk '{print $1}')" == "$EXPECTED_SHA256" ]] || fatal 'Backup verification failed.'

log "Source is $active_state and $enabled_state; existing enablement will not be modified."
log "Verified backup: $backup"
transaction_started=1

# The unit name is part of systemd's identity. A short stop/start is required;
# an alias alone cannot transfer the already-running unit's identity.
systemctl stop "$OLD_NAME"
mv -- "$OLD_UNIT" "$NEW_UNIT"
ln -s -- "$NEW_NAME" "$OLD_UNIT"
systemctl daemon-reload

if (( was_active )); then
  systemctl start "$NEW_NAME"
  [[ "$(systemctl is-active "$NEW_NAME")" == active ]] || fatal 'New unit did not become active.'
else
  [[ "$(systemctl is-active "$NEW_NAME" 2>/dev/null || true)" == inactive ]] || fatal 'New unit unexpectedly became active.'
fi

new_enabled=$(systemctl is-enabled "$NEW_NAME" 2>/dev/null || true)
if (( was_enabled )); then
  [[ "$new_enabled" == enabled ]] || fatal "Enablement changed unexpectedly: $new_enabled"
else
  [[ "$new_enabled" == disabled ]] || fatal "Expected the renamed service to remain disabled; got '$new_enabled'."
fi
[[ -L "$OLD_UNIT" && "$(readlink -- "$OLD_UNIT")" == "$NEW_NAME" ]] || fatal 'Legacy-name compatibility symlink verification failed.'
[[ "$(sha256sum -- "$NEW_UNIT" | awk '{print $1}')" == "$EXPECTED_SHA256" ]] || fatal 'Renamed unit content verification failed.'

committed=1
trap - ERR INT TERM
log "Migration complete: $NEW_NAME is $([[ $was_active -eq 1 ]] && printf active || printf inactive), enablement remains $new_enabled."
log "Compatibility alias retained at $OLD_UNIT; backup retained at $backup."
log 'No ExecStart/ExecStop helpers, PID paths, or network namespaces were changed.'
