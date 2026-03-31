#!/bin/sh
set -e

mkdir -p /root/.tokligence/config/dev /root/.tokligence/logs /data

cat > /root/.tokligence/config/settings.ini << 'EOF'
environment=dev
EOF

# Unquoted EOF so shell substitutes env vars
cat > /root/.tokligence/config/dev/gateway.ini << EOF
auth_disabled=true
auth_secret=${TOKLIGENCE_AUTH_SECRET:-tokligence-dev-secret}
log_level=info
ledger_path=/data/ledger.db
identity_path=/data/identity.db
work_mode=auto

anthropic_base_url=https://api.minimax.io/anthropic
anthropic_api_key=${MINIMAX_API_KEY}

openai_base_url=${MODAL_GLM5_API_BASE}
openai_api_key=${MODAL_GLM5_API_KEY}

sidecar_model_map=zai-org/GLM-5-FP8=zai-org/GLM-5-FP8

model_provider_routes=MiniMax*=anthropic,zai-org*=openai
routes=MiniMax*=>anthropic,zai-org*=>openai,loopback=>loopback

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
