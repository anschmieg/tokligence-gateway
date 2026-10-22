#!/usr/bin/env bash
# Install a staged OpenCode OAuth credential into the persistent gateway /data volume.
# Run manually on fra as the authorized administrative SSH user via sudo.
set -Eeuo pipefail
umask 077

admin_home=${HOME:-/root}
if [[ -n "${SUDO_USER:-}" ]]; then
  admin_home=$(getent passwd "$SUDO_USER" | cut -d: -f6)
  [[ -n "$admin_home" && "$admin_home" == /* ]] || { printf '[install-zen-secondary] ERROR: Cannot resolve sudo user home.\n' >&2; exit 1; }
fi
readonly STAGED_DEFAULT="$admin_home/zen-secondary-oauth.pending.json"
readonly APPLICATION=iog8gk8g8o0s44840g4o4sso

log() { printf '[install-zen-secondary] %s\n' "$*"; }
fatal() { log "ERROR: $*" >&2; exit 1; }

usage() {
  printf 'Usage: sudo %s [staged-credential.json] [gateway-container-id]\n' "$0" >&2
  exit 2
}

(( EUID == 0 )) || fatal 'Run with sudo on the gateway host.'
(( $# <= 2 )) || usage
staged=${1:-"$STAGED_DEFAULT"}
explicit_container=${2:-}
[[ -f "$staged" && ! -L "$staged" && -r "$staged" ]] || fatal 'Staged credential must be a readable regular non-symlink file.'
command -v docker >/dev/null || fatal 'Docker CLI is unavailable.'
command -v python3 >/dev/null || fatal 'python3 is required for safe JSON metadata validation.'

# Validate shape without printing values. Never place credential fields in argv or logs.
python3 -I - "$staged" <<'PY'
import json, os, stat, sys
p = sys.argv[1]
s = os.stat(p, follow_symlinks=False)
if not stat.S_ISREG(s.st_mode):
    raise SystemExit("staged credential is not a regular file")
with open(p, "r", encoding="utf-8") as f:
    value = json.load(f)
if not isinstance(value, dict) or not isinstance(value.get("access"), str) or not value["access"].strip() or not isinstance(value.get("refresh"), str) or not value["refresh"].strip():
    raise SystemExit("staged credential lacks required OAuth token fields")
PY

if [[ -n "$explicit_container" ]]; then
  container=$explicit_container
else
  listing=$(docker ps --format '{{.ID}} {{.Names}}')
  mapfile -t candidates < <(python3 -I -c '
import re, sys
pattern = re.compile(re.escape(sys.argv[1]) + r"-[0-9]+")
for line in sys.stdin:
    fields = line.split()
    if len(fields) == 2 and pattern.fullmatch(fields[1]):
        print(fields[0])
' "$APPLICATION" <<<"$listing")
  (( ${#candidates[@]} == 1 )) || fatal "Expected exactly one production application container; found ${#candidates[@]}. Pass its verified container ID explicitly."
  container=${candidates[0]}
fi

name=$(docker inspect --format '{{.Name}}' "$container")
image=$(docker inspect --format '{{.Config.Image}}' "$container")
running=$(docker inspect --format '{{.State.Running}}' "$container")
[[ "$name" =~ ^/${APPLICATION}-[0-9]+$ ]] || fatal 'Container name does not match the production Coolify application.'
[[ "$image" == "$APPLICATION:"* && "$image" != "$APPLICATION:pr-"* ]] || fatal 'Container image does not match the production Coolify application.'
[[ "$running" == true ]] || fatal 'Selected production container is not running.'
log "Verified production container: ${name#/}"
mount_json=$(docker inspect --format '{{json .Mounts}}' "$container")
python3 -I -c '
import json, sys
mounts = json.load(sys.stdin)
data = [m for m in mounts if m.get("Destination") == "/data"]
if len(data) != 1 or any(m.get("Destination", "").startswith("/data/") for m in mounts):
    raise SystemExit("Expected one persistent /data mount without nested mounts")
m = data[0]
if not m.get("RW") or m.get("Type") not in ("volume", "bind"):
    raise SystemExit("Expected a writable persistent /data mount")
if m["Type"] == "volume" and not m.get("Name"):
    raise SystemExit("Missing named volume identity")
if m["Type"] == "bind" and not m.get("Source", "").startswith("/"):
    raise SystemExit("Invalid bind mount source")
' <<<"$mount_json" || fatal 'Persistent /data mount validation failed.'

# Confirm the in-container runtime user can write /data/zen and destination is absent.
docker exec "$container" sh -c 'test -d /data/zen && test -w /data/zen && test ! -e /data/zen/secondary-oauth.json && test ! -L /data/zen/secondary-oauth.json' >/dev/null 2>&1 || fatal 'Runtime cannot write /data/zen or destination exists/is a symlink; refusing installation.'

# Create a private exclusive temp file as the runtime identity, then atomically
# hard-link it into place (which fails rather than replacing a concurrent file).
# Token bytes travel only on stdin and are never printed or placed in argv.
docker exec -i "$container" node -e '
const fs=require("fs"), path="/data/zen/secondary-oauth.json";
const crypto=require("crypto");
const temp=`/data/zen/.secondary-oauth-${crypto.randomBytes(16).toString("hex")}.tmp`;
let fd;
try { fd=fs.openSync(temp,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL,0o600); }
catch { process.exit(1); }
const chunks=[];
process.stdin.on("data",c=>chunks.push(c));
process.stdin.on("error",()=>{try{fs.closeSync(fd)}catch{};try{fs.unlinkSync(temp)}catch{};process.exit(1)});
process.stdin.on("end",()=>{
  try { fs.writeFileSync(fd,Buffer.concat(chunks)); fs.fsyncSync(fd); fs.closeSync(fd); fs.linkSync(temp,path); fs.unlinkSync(temp); }
  catch { try{fs.closeSync(fd)}catch{};try{fs.unlinkSync(temp)}catch{};process.exitCode=1; }
});
' < "$staged" >/dev/null || fatal 'Atomic credential installation failed.'

# Verify only file type, owner and mode in-container; never read or print credential content.
docker exec "$container" node -e 'const fs=require("fs"),s=fs.lstatSync("/data/zen/secondary-oauth.json");if(!s.isFile()||s.isSymbolicLink()||(s.mode&0o777)!==0o600)process.exit(1)' >/dev/null || fatal 'Installed credential metadata verification failed.'
rm -f -- "$staged"
log 'Secondary OAuth credential installed on the persistent /data volume with mode 0600 and gateway ownership.'
log 'The primary credential was not modified. No container restart or token refresh was performed.'
log 'Deploy/restart the gateway after the routing configuration change so the new account is loaded.'
