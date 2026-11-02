#!/bin/sh
set -eu
root=/home/agent/cliproxy-staging
# Written only after the verified host process has stopped. Single owner across
# container restarts and rolling deploys; no token/DB migration is performed.
test -f "$root/state/coolify-owner.ready" || { echo 'Runtime ownership handoff is not ready' >&2; exit 1; }
# Legacy deployment environment values must not become native auth seeds.
unset OPENCODE_API_KEY OPENCODE_ZEN_ACCESS_TOKEN OPENCODE_ZEN_REFRESH_TOKEN OPENCODE_ZEN_EXPIRES_MS OPENCODE_ZEN_ORG_ID OPENCODE_ZEN_ORG_NAME OPENCODE_ZEN_PROXY CODEX_AUTO_DEVICE_LOGIN CODEX_PROXY_API_KEY TOKLIGENCE_ADMIN_SECRET TOKLIGENCE_AUTH_SECRET
hostname -i > "$root/state/coolify-container-address"
exec flock --nonblock --no-fork "$root/state/coolify-runtime.lock" "$root/bin/cli-proxy-api" --config "$root/config/config.yaml" --local-model
