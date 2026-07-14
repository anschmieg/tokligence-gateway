#!/bin/sh
set -eu

export TOKLIGENCE_EMAIL="${TOKLIGENCE_EMAIL:-admin@local}"
export TOKLIGENCE_ANTHROPIC_API_KEY="${MINIMAX_API_KEY:-}"
export TOKLIGENCE_OPENAI_API_KEY="${OPENAI_API_KEY:-}"
export MINIMAX_API_BASE="${MINIMAX_API_BASE:-}"
export MODAL_GLM5_API_BASE="${MODAL_GLM5_API_BASE:-}"

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

  if [ -z "${CODEX_PROXY_BASE_URL:-}" ]; then
    cat > /data/cliproxy/config.yaml << EOF
host: "127.0.0.1"
port: 8317
remote-management:
  allow-remote: false
  secret-key: ""
  disable-control-panel: true
auth-dir: "/data/cliproxy/auth"
api-keys:
  - "${CODEX_PROXY_API_KEY}"
debug: false
logging-to-file: false
usage-statistics-enabled: false
EOF

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

cat > /app/config/settings.ini << 'EOF'
environment=dev
EOF

# Unquoted EOF so shell substitutes env vars
cat > /app/config/dev/gateway.ini << EOF
auth_disabled=true
auth_secret=${TOKLIGENCE_AUTH_SECRET}
log_level=info
ledger_path=/data/ledger.db
identity_path=/data/identity.db
work_mode=auto

anthropic_api_key=${TOKLIGENCE_ANTHROPIC_API_KEY}
anthropic_base_url=${MINIMAX_API_BASE:-https://api.minimax.io/anthropic}

openai_api_key=${TOKLIGENCE_OPENAI_API_KEY}
openai_base_url=${OPENAI_API_BASE:-https://api.openai.com/v1}

sidecar_model_map=glm-5.1:cloud=zai-org/GLM-5.1-FP8,glm-5:cloud=zai-org/GLM-5-FP8

model_provider_routes=claude*=anthropic,gpt*=openai,MiniMax*=anthropic,zai-org*=openai
routes=claude*=>anthropic,gpt*=>openai,MiniMax*=>anthropic,zai-org*=>openai,loopback=>loopback

enable_facade=true
multiport_mode=false
facade_port=8081
bridge_session_enabled=false
bridge_session_ttl=5m
bridge_session_max_count=1000
EOF

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
