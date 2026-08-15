# Tokligence unified gateway

`tgw-proxy.mjs` is the only public HTTP service. It authenticates clients,
publishes the unified model/provider registry, and routes each exact model to
Tokligence or a configured provider adapter.

Tokligence remains the default backend. Codex OAuth is optional and is reached
through CLIProxyAPI v7.2.75 embedded in the same container. The adapter binds
only to loopback and is never exposed directly to the internet.

## Public endpoints

- `GET /health` — façade and backend-configuration status
- `GET /v1/models` — unified model registry, rebuilt live on every request by
  re-pulling each enabled provider's `/models` endpoint (so the list always
  reflects the current upstream contents). OpenRouter surfaces free models by
  default; any paid exceptions must be explicitly allowlisted in the routing
  catalog.
- `GET /v1/providers` — configured provider registry without secrets
- `GET /admin/routes` — effective routing policy without secrets
- `GET /admin/status` — dashboard status (providers, model count)
- `GET /admin/quota` — live per-provider quota/usage (fail-safe, no secrets)
- `GET /admin/preferences` — current routing-preference overrides
- `POST /admin/preferences` — set/update a routing-preference override
- `POST /admin/preferences/clear` — clear one override
- `POST /admin/preferences/reset` — clear all overrides
- `GET /dashboard` — admin dashboard UI (visiting `/` redirects here so the access-controlled path is used)
- `POST /v1/messages` — Anthropic Messages, including streaming and tools
- `POST /v1/messages/count_tokens` — Anthropic token counting
- `POST /v1/responses` — OpenAI Responses
- `POST /v1/chat/completions` — OpenAI Chat Completions

All endpoints except `/health` require the existing gateway bearer token.
`/admin/*` is protected by **either** a separate `TOKLIGENCE_ADMIN_SECRET`
shared secret **or** a Cloudflare Access JWT. To use Cloudflare Access, deploy
this service behind a Cloudflare Access application and set the environment
variables documented below. The public gateway token cannot access
administrative routes, and `/health` intentionally returns only a generic
liveness result that exposes no provider state.

### Cloudflare Access auth (optional)

Instead of (or in addition to) `TOKLIGENCE_ADMIN_SECRET`, you can protect the
dashboard with Cloudflare Access. Cloudflare sits in front of the gateway,
validates the user's identity, and sends a signed JWT in the `Cf-Access-Jwt`
request header. The gateway verifies that JWT against Cloudflare's public
JWKS.

```dotenv
# Cloudflare Zero Trust team name (subdomain of your Access dashboard)
CLOUDFLARE_ACCESS_TEAM=my-company
# The application Audience Tag shown on the Access application page
CLOUDFLARE_ACCESS_AUD=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
# Optional: override the JWKS URL (defaults to
#   https://<TEAM>.cloudflareaccess.com/cdn-cgi/access/certs)
# CLOUDFLARE_ACCESS_JWKS_URL=https://...custom-certs.../certs
# Optional air-gapped inline certs (JSON JWKS) — takes precedence over the URL
# CLOUDFLARE_ACCESS_CERTS={"keys":[...]}
```

When Cloudflare Access is configured, the browser flow needs no admin secret:
Cloudflare handles identity, injects the JWT, and the dashboard unlocks
automatically. You can keep `TOKLIGENCE_ADMIN_SECRET` as a fallback for
operators, or set it to an empty value and rely entirely on Cloudflare Access.
Both auth methods are checked on every `/admin/*` request.

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

## Dashboard

`GET /dashboard` serves a self-contained admin UI (`/` 302-redirects to it so
the browser always lands on the Cloudflare-Access-protected path). When Cloudflare
Access is configured, the dashboard unlocks automatically after Cloudflare
performs identity check; otherwise enter `TOKLIGENCE_ADMIN_SECRET` (or pass it
in the URL hash as `#token=<secret>`). The dashboard has two sections:

- **Provider quota / usage** — probes each enabled provider for how much of its
  quota/balance has been consumed (OpenRouter spend vs. cap, Mistral
  reachability, MiniMax balance where available) using `quota.mjs`. Providers
  without a working balance API report themselves as *reachable* or
  *unavailable* rather than failing the page. No credentials are ever shown.
- **Routing preferences** — lets you re-target capability profiles / aliases to
  a different provider + model and set a fallback. Two levels of persistence:
  - **Apply now** — updates the running process immediately via
    `preferences.mjs` and writes a sidecar file (default
    `/data/gateway.preferences.yaml`, overridable with
    `ROUTING_PREFERENCES_PATH`) so the running instance keeps the overrides.
  - **Persist to config** — bakes the current overrides into
    `gateway.routes.yaml` itself (`POST /admin/preferences/bake`), so they
    become permanent policy that survives a restart and deploy. This is the
    recommended way to save routing changes; `gateway.routes.yaml` remains the
    single source of truth. Baking clears the now-redundant runtime overrides.

  `POST /admin/preferences/reset` removes all runtime overrides (it does not
  edit `gateway.routes.yaml`).

### Dashboard API

All dashboard endpoints use the admin secret and never return credentials:

| Method | Path | Purpose |
| ------ | ---- | ------- |
| GET | `/admin/routes` | effective sanitized routing policy |
| GET | `/admin/status` | providers, model count, preferences file |
| GET | `/admin/quota` | per-provider quota usage |
| GET | `/admin/preferences` | current overrides |
| POST | `/admin/preferences` | body `{ id, override: { provider, target, fallback } }` |
| POST | `/admin/preferences/clear` | body `{ id }` |
| POST | `/admin/preferences/reset` | clear all overrides |
| POST | `/admin/preferences/bake` | write overrides into `gateway.routes.yaml` |

The set endpoints validate that the alias exists and that any explicitly
referenced provider is currently enabled; invalid writes return `422`. The bake
endpoint rewrites `gateway.routes.yaml` (a no-op when no overrides exist) and
returns the number of aliases updated; the file is validated on the next start
by `compile-config.mjs`.

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

## Codex client (CLI and desktop app)

Point the official Codex CLI / desktop app at this gateway via a custom
provider, while keeping your native OpenAI (OAuth) login available side by side.

### Usage at a glance

| Surface | Custom gateway (default) | ChatGPT login |
| --- | --- | --- |
| **CLI** | `codex` (gateway is the default) | `codex --openai` |
| **CLI, explicit** | `codex --gateway` | `codex --profile openai` |
| **Desktop app** | `codex --gateway app` (already the default) | `codex --openai app` |

### CLI

- `codex "prompt"` starts a session on the **gateway** with the default model
  (`minimax-m2.7`). Pick any of the 56 gateway models with `codex -m <model>`;
  `codex --gateway` is the same thing spelled out. For non-interactive use,
  run `codex exec` instead, e.g. `codex --gateway exec "run the tests"`.
- `codex --openai "prompt"` runs on **official OpenAI** through your ChatGPT
  OAuth login. Add `-m` to pick an official model, e.g.
  `codex --openai -m gpt-5.4`. `codex --profile openai` is the same thing
  without the wrapper sugar.
- `codex resume` (or `codex resume <session-id>`) continues a past session;
  the session uses the provider it was started with.
- `--openai` and `--gateway` are provided by the local wrapper
  `~/.local/bin/codex`; they translate to Codex's `--profile openai` and
  `--profile tokligence`. The same flags also switch the desktop app:
  `codex --openai app` / `codex --gateway app` (see below).

### Desktop app

The desktop app only reads the top-level values in `~/.codex/config.toml`
(`--profile` is a CLI-only flag), so it uses the **gateway** out of the box:
every gateway model appears in the app's model picker.

Switch the desktop app between the two setups with the wrapper:

```sh
codex --gateway app [PATH]   # desktop app on the gateway (default)
codex --openai app [PATH]    # desktop app on your ChatGPT login
```

`PATH` (defaults to the current directory) is the workspace the app opens.
Because the desktop app is a single instance that keeps the config it was
launched with, switching closes and relaunches it; open threads in the app are
not preserved across a switch.

`codex --openai app` launches the app with an alternate config home at
`~/.cache/codex-gui/openai`: a fresh copy of `~/.codex/config.toml` with the
three top-level values below swapped to the ChatGPT login (everything else is
symlinked back to `~/.codex`), so `~/.codex/config.toml` is never modified.
`codex --gateway app` launches the app normally, i.e. with the gateway
defaults.

The manual equivalent (no wrapper) is to swap the three top-level lines in
`~/.codex/config.toml` and restart the app:

```toml
# ~/.codex/config.toml - gateway (the default)
model = "minimax-m2.7"
model_provider = "tokligence"
model_catalog_json = "/Users/adrian/.codex/tokligence-models.json"
```

```toml
# ~/.codex/config.toml - ChatGPT login (desktop app switch)
model = "gpt-5.6-sol"
model_provider = "openai"
model_catalog_json = "/Users/adrian/.codex/models_cache.json"
```

### Configuration layout

`~/.codex/config.toml` holds the shared base config (provider definitions,
plugins, desktop settings) and defaults to the gateway. The two switchable CLI
setups live in per-profile files that Codex layers on top of the base config
(via `codex --profile <name>`, which loads `$CODEX_HOME/<name>.config.toml`):

```toml
# ~/.codex/openai.config.toml     - official OpenAI API via OAuth
model = "gpt-5.6-sol"
model_provider = "openai"
model_catalog_json = "/Users/adrian/.codex/models_cache.json"
model_reasoning_effort = "none"
service_tier = "default"
```

```toml
# ~/.codex/tokligence.config.toml - explicit gateway profile (same as default)
model = "minimax-m2.7"
model_provider = "tokligence"
model_catalog_json = "/Users/adrian/.codex/tokligence-models.json"
model_reasoning_effort = "none"
service_tier = "default"
```

The base `~/.codex/config.toml` sets the same values as the `tokligence`
profile at top level, plus the provider definition:

```toml
[model_providers.tokligence]
name = "Tokligence Gateway"
base_url = "https://code.nothing.pink/v1"   # OpenAI-compatible endpoint
env_key = "CODEX_GATEWAY_API_KEY"
wire_api = "responses"
```

Current Codex builds reject legacy `[profiles.*]` tables inside `config.toml`
(`profile = "..."` / `[profiles.tokligence]`); use the per-file profile layout
above instead.

The deprecated predecessor gateway `ai.nothing.pink` (`nothing-ai` provider,
`NOTHING_AI_API_KEY`) is still defined in the base config so older sessions
that used its models (e.g. `opencode/deepseek-v4-flash-free`) can be resumed;
it is not the default provider.

`tokligence-models.json` is a snapshot of the gateway's `GET /v1/models`
catalog (`codex debug models` renders it). Regenerate it with:

```sh
curl -fsS -H "Authorization: Bearer $CODEX_GATEWAY_API_KEY" \
  https://code.nothing.pink/v1/models
```

## Mistral via Vibe subscription

Add a Mistral provider that uses a Vibe plan API key. Create the key in the Mistral console under **Code → Vibe CLI** so requests consume the subscription's monthly Vibe budget instead of a separately billed developer key.

```dotenv
MISTRAL_API_KEY=replace-with-vibe-key
# Optional override; the default is the OpenAI-compatible Mistral endpoint.
MISTRAL_API_BASE=https://api.mistral.ai/v1
```

Models can be requested with the `mistral/` prefix or bare Mistral IDs, for example `mistral/mistral-large-latest` or `mistral-large-latest`. The proxy discovers available models from Mistral's `/v1/models` endpoint and falls back to the configured model list when discovery is unavailable.

Streaming is supported on `/v1/chat/completions`. The Anthropic Messages and OpenAI Responses endpoints are translated to Mistral's OpenAI-compatible chat completions and returned in the requested format.

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
