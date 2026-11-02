#!/bin/sh
set -eu
root=/home/agent/cliproxy-staging
# Written only after the verified host process has stopped. Single owner across
# container restarts and rolling deploys; no token/DB migration is performed.
test -f "$root/state/coolify-owner.ready" || { echo 'Runtime ownership handoff is not ready' >&2; exit 1; }
exec flock --nonblock --no-fork "$root/state/coolify-runtime.lock" "$root/bin/cli-proxy-api" --config "$root/config/config.yaml" --local-model
