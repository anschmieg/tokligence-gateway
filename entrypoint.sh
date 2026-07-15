#!/bin/sh
set -eu

mkdir -p /app/config/dev /root/.tokligence/logs /data /data/cliproxy/auth

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
    break
  fi
  echo "Waiting for gateway... ($i)"
  sleep 1
done

exec node /app/tgw-proxy.mjs
