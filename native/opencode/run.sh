#!/bin/sh
set -eu
: "${OPENCODE_NATIVE_STATE:?Set an isolated, persistent worker state directory}"
: "${OPENCODE_NATIVE_SOURCE:?Set the prepared OpenCode source directory}"
export XDG_DATA_HOME="$OPENCODE_NATIVE_STATE/data"
export XDG_CONFIG_HOME="$OPENCODE_NATIVE_STATE/xdg-config"
export XDG_CACHE_HOME="$OPENCODE_NATIVE_STATE/cache"
export XDG_STATE_HOME="$OPENCODE_NATIVE_STATE/xdg-state"
umask 077
exec "${OPENCODE_NATIVE_BUN:-bun}" run "$OPENCODE_NATIVE_SOURCE/packages/sdk/src/tokligence-bridge.ts"
