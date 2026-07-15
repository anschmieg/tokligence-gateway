# Tokligence unified gateway

`tgw-proxy.mjs` is the only public HTTP service. It authenticates clients,
publishes the unified model/provider registry, and routes each exact model to
Tokligence or a configured provider adapter.

Tokligence remains the default backend. Codex OAuth is optional and is reached
through CLIProxyAPI v7.2.75 embedded in the same container. The adapter binds
only to loopback and is never exposed directly to the internet.

## Public endpoints

- `GET /health` — façade and backend-configuration status
- `GET /v1/models` — unified model registry
- `GET /v1/providers` — configured provider registry without secrets
- `GET /admin/routes` — effective routing policy without secrets
- `POST /v1/messages` — Anthropic Messages, including streaming and tools
- `POST /v1/messages/count_tokens` — Anthropic token counting
- `POST /v1/responses` — OpenAI Responses
- `POST /v1/chat/completions` — OpenAI Chat Completions

All endpoints except `/health` require the existing gateway bearer token.
`/admin/*` uses a separate `TOKLIGENCE_ADMIN_SECRET`; the public gateway token
cannot access administrative routes. `/health` intentionally returns only a
generic liveness result and exposes no provider state.

## Routing policy

Edit `gateway.routes.yaml` to manage providers, models, aliases, routes, and
OAuth credential-pool policy. Secrets remain in the deployment environment and
are referenced by environment-variable name. At container startup,
`compile-config.mjs` validates this policy and generates the private Tokligence
and OAuth-proxy configuration files. Invalid policy prevents startup.

A deployment restart is the single apply operation. There is intentionally no
partial hot reload: the middleware, Tokligence, and OAuth proxy always start
from the same policy revision. `GET /admin/routes` shows the effective sanitized
policy currently in use.

CLIProxyAPI is used strictly as the OAuth proxy. It owns OAuth login, refresh,
credential selection, affinity, and retry/cooldown behavior. Add an account with
its device-login command; credentials persist under `/data/cliproxy/auth`. The
public middleware never exposes or modifies OAuth tokens.

## Codex backend

Enable the embedded adapter and give it a separate internal key:

```dotenv
CODEX_PROXY_ENABLED=true
CODEX_AUTO_DEVICE_LOGIN=true
CODEX_PROXY_API_KEY=replace-with-a-separate-internal-key
TOKLIGENCE_ADMIN_SECRET=replace-with-a-separate-admin-key
```

The internal key must be different from `TOKLIGENCE_AUTH_SECRET`. Leave
`CODEX_PROXY_BASE_URL` unset to use the embedded loopback service. An explicit
base URL remains supported for an external adapter.

OAuth credentials persist under `/data/cliproxy/auth`. With automatic device
login enabled, the first deployment without a credential prints an OpenAI
device URL and code to the application logs. Complete that authorization once;
future starts detect the persistent credential and skip the login flow.

The equivalent manual command is:

```sh
cli-proxy-api --codex-device-login --no-browser --config /data/cliproxy/config.yaml
```

Open the displayed OpenAI device URL and enter its code. The running adapter
automatically discovers the saved credential.

Codex models, Claude tier aliases, pool strategy, affinity, and retry limits are
configured only in `gateway.routes.yaml`. Unlisted `gpt-5.6-*` IDs return 404
and never fall through to another provider.

Each Claude tier has one mapping with multiple wildcard patterns, covering both
tier-first names such as `claude-sonnet-4.5` and version-first names such as
`claude-3.5-sonnet` without duplicating its target configuration.

For Claude Code, adaptive thinking and `output_config.effort` are forwarded
unchanged. The internal adapter translates the explicit `low`, `medium`,
`high`, `xhigh`, and `max` values to Codex `reasoning.effort`.

## Claude Code wrapper

The client can keep using Claude's built-in model classes:

```sh
export ANTHROPIC_BASE_URL="https://code.nothing.pink"
export ANTHROPIC_AUTH_TOKEN="$CLAUDEX_GATEWAY_TOKEN"

export ANTHROPIC_DEFAULT_HAIKU_MODEL="gpt-5.6-luna"
export ANTHROPIC_DEFAULT_SONNET_MODEL="gpt-5.6-terra"
export ANTHROPIC_DEFAULT_OPUS_MODEL="gpt-5.6-sol"
export ANTHROPIC_DEFAULT_FABLE_MODEL="gpt-5.6-sol"

capabilities="effort,xhigh_effort,max_effort,thinking,adaptive_thinking,interleaved_thinking"
export ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES="$capabilities"
export ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES="$capabilities"
export ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES="$capabilities"
export ANTHROPIC_DEFAULT_FABLE_MODEL_SUPPORTED_CAPABILITIES="$capabilities"

exec claude "$@"
```

Examples:

```sh
claudex --model haiku --effort low
claudex --model sonnet --effort high
claudex --model opus --effort xhigh
claudex --model fable --effort max
```

## Verification

```sh
npm install
npm run lint
npm test
npm audit --audit-level=high
docker build -t tokligence-unified-gateway .
```

The integration test uses mock Tokligence and Codex backends. It verifies
authentication separation, exact model routing, effort preservation, SSE
pass-through, token counting, fail-closed behavior, and unchanged fallback to
Tokligence.
