# Source ONLY in a disposable Warp lab zsh shell, never in ~/.zshrc.
# export WARP_LAB_WORKSPACE=/absolute/path/to/disposable/project
# export WARP_LAB_EVENTS=/absolute/path/to/private/shell-events.jsonl
# source /path/to/shell_probe.zsh
# Captures shell command execution but NOT Warp's native file reads/context APIs.
autoload -Uz add-zsh-hook

_warp_lab_in_scope() {
  [[ -n "$WARP_LAB_WORKSPACE" && -n "$WARP_LAB_EVENTS" ]] || return 1
  [[ "$WARP_LAB_WORKSPACE" == /* && "$WARP_LAB_EVENTS" == /* ]] || return 1
  [[ "$PWD" == "$WARP_LAB_WORKSPACE" || "$PWD" == "$WARP_LAB_WORKSPACE"/* ]]
}

_warp_lab_preexec() {
  _warp_lab_in_scope || return 0
  /usr/bin/env python3 -c '
import json, os, pathlib, re, sys, time
path = pathlib.Path(os.environ["WARP_LAB_EVENTS"])
if path.is_symlink() or not path.parent.is_dir() or path.parent.stat().st_mode & 0o077:
    raise SystemExit(0)
command = re.sub(r"(?i)(api_key|token|password|secret|authorization)\s*=\s*[^\s]+", r"\1=[REDACTED]", sys.argv[2])
entry = {"schema":"warp-shell-event/v1","ts_unix_ns":time.time_ns(),
         "kind":"preexec","cwd":sys.argv[1],"command":command,"actor":"unknown"}
fd=os.open(path,os.O_WRONLY|os.O_APPEND|os.O_CREAT|os.O_NOFOLLOW,0o600)
with os.fdopen(fd,"a",encoding="utf-8") as out: out.write(json.dumps(entry)+"\n")
' "$PWD" "$1" 2>/dev/null
}
add-zsh-hook preexec _warp_lab_preexec
