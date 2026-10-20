#!/bin/sh
set -eu

mkdir -p /app/config/dev /root/.tokligence/logs /data /data/cliproxy/auth /data/zen

# Disposable synthetic Warp experiment traces. Disabled and uncreated normally.
if [ "${WARP_TRACE_ENABLED:-0}" = "1" ]; then
  umask 077
  mkdir -p /data/warp-context-traces
  chmod 0700 /data/warp-context-traces
  umask 022
fi

# OpenCode Zen free tier needs the OAuth credential from a Console sign-in, not a
# Console API key. The credential arrives as environment variables and is written
# to the persistent volume; the adapter refreshes it in place before it expires.
#
# The adapter rotates the refresh token and rewrites /data/zen/oauth.json, so the
# environment variables are only a bootstrap value: reseeding them on every start
# would restore an already-revoked token and leave the provider failing with
# "Invalid credential". The stored credential therefore wins unless the caller
# proves it is newer (a later expiry) or asks for it explicitly.
zen_is_digits() { case "$1" in ''|*[!0-9]*) return 1 ;; *) return 0 ;; esac; }

if [ -n "${OPENCODE_ZEN_ACCESS_TOKEN:-}" ]; then
  zen_env_expires=${OPENCODE_ZEN_EXPIRES_MS:-0}
  zen_is_digits "$zen_env_expires" || zen_env_expires=0
  zen_stored_expires=0
  if [ -f /data/zen/oauth.json ]; then
    zen_stored_expires=$(sed -n 's/.*"expires":\([0-9][0-9]*\).*/\1/p' /data/zen/oauth.json | head -1)
    zen_is_digits "$zen_stored_expires" || zen_stored_expires=0
  fi

  if [ -f /data/zen/oauth.json ] \
     && [ "${OPENCODE_ZEN_FORCE_SEED:-false}" != "true" ] \
     && [ "$zen_env_expires" -le "$zen_stored_expires" ]; then
    echo "Kept stored OpenCode Zen credential (expires $zen_stored_expires; env expires $zen_env_expires). Set OPENCODE_ZEN_FORCE_SEED=true to replace it."
  else
    umask 077
    cat > /data/zen/oauth.json <<ZEN_JSON
{"type":"oauth","methodID":"device","access":"${OPENCODE_ZEN_ACCESS_TOKEN}","refresh":"${OPENCODE_ZEN_REFRESH_TOKEN:-}","expires":${OPENCODE_ZEN_EXPIRES_MS:-0},"metadata":{"server":"https://opencode.ai/console","orgID":"${OPENCODE_ZEN_ORG_ID:-}","orgName":"${OPENCODE_ZEN_ORG_NAME:-}"}}
ZEN_JSON
    umask 022
    echo "Wrote OpenCode Zen credential to /data/zen/oauth.json"
  fi
elif [ ! -f /data/zen/oauth.json ]; then
  echo "NOTE: OpenCode Zen disabled; no credential at /data/zen/oauth.json and OPENCODE_ZEN_ACCESS_TOKEN is unset"
fi

if [ "${CODEX_PROXY_ENABLED:-false}" = "true" ]; then
  if [ -z "${CODEX_PROXY_API_KEY:-}" ]; then
    echo "ERROR: CODEX_PROXY_API_KEY is required when CODEX_PROXY_ENABLED=true" >&2
    exit 1
  fi

  case "${CODEX_PROXY_API_KEY}" in
    *[!A-Za-z0-9._-]*)
      echo "ERROR: CODEX_PROXY_API_KEY may only contain letters, numbers, dots, underscores, and hyphens" >&2
      exit 1
      ;;
  esac

fi

# Compile Tokligence and OAuth-proxy configs from the single routing policy.
# Separate ephemeral local-management authority; never reuse the public API key.
if [ -z "${CODEX_MANAGEMENT_KEY:-}" ]; then
  CODEX_MANAGEMENT_KEY="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"
  export CODEX_MANAGEMENT_KEY
fi
node /app/compile-config.mjs

if [ "${CODEX_PROXY_ENABLED:-false}" = "true" ]; then
  if [ -z "${CODEX_PROXY_BASE_URL:-}" ]; then

    echo "Starting embedded CLIProxyAPI on 127.0.0.1:8317"
    cli-proxy-api --config /data/cliproxy/config.yaml &
    export CODEX_PROXY_BASE_URL=http://127.0.0.1:8317

    for i in $(seq 1 30); do
      if curl -fsS -H "Authorization: Bearer ${CODEX_PROXY_API_KEY}" http://127.0.0.1:8317/v1/models > /dev/null 2>&1; then
        echo "CLIProxyAPI ready after ${i}s"
        break
      fi
      if [ "$i" -eq 30 ]; then
        echo "ERROR: CLIProxyAPI did not become ready" >&2
        exit 1
      fi
      sleep 1
    done

    if [ "${CODEX_AUTO_DEVICE_LOGIN:-false}" = "true" ] \
      && ! find /data/cliproxy/auth -type f -name '*.json' -print -quit | grep -q .; then
      echo "No Codex OAuth credential found; starting one-time device authorization"
      cli-proxy-api --codex-device-login --no-browser --config /data/cliproxy/config.yaml &
    fi
  else
    echo "Using external Codex OAuth adapter: ${CODEX_PROXY_BASE_URL}"
  fi
else
  unset CODEX_PROXY_BASE_URL CODEX_PROXY_API_KEY
fi

GATEWAYD=$(find /usr/local/lib/node_modules/@tokligence/gateway -name "gatewayd" -type f 2>/dev/null | head -1)
if [ -z "$GATEWAYD" ]; then
  echo "ERROR: gatewayd binary not found" && exit 1
fi

echo "Starting gatewayd: $GATEWAYD"
"$GATEWAYD" &

# Wait up to 30s for gateway to bind
for i in $(seq 1 30); do
  if wget -q -O- http://127.0.0.1:8081/health > /dev/null 2>&1; then
    echo "Gateway ready after ${i}s"
    exec node /app/tgw-proxy.mjs
  fi
  echo "Waiting for gateway... ($i)"
  sleep 1
done

echo "ERROR: gatewayd did not become ready" >&2
exit 1
