#!/bin/sh
set -e

mkdir -p ~/.tokligence/config/dev ~/.tokligence/logs

cat > ~/.tokligence/config/settings.ini << 'EOF'
environment=dev
EOF

cat > ~/.tokligence/config/dev/gateway.ini << EOF
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

# Start gateway in background
tgw start 2>&1 &
sleep 2

# Start proxy in foreground (keeps container alive, logs to stdout)
exec node /app/tgw-proxy.mjs
