# Cline plugin (CLIProxyAPI v8.0.49)

First-slice dynamic-library plugin for mainline
[router-for-me/CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) `v8.0.49`
that owns Cline OAuth credentials and translates chat-completions requests to the
Cline API. It ports the source-backed logic of the existing gateway adapter
(`cline-oauth.mjs`) into the upstream plugin interface; no gateway runtime is
involved.

## What is implemented

| Capability | RPC methods | Status |
| --- | --- | --- |
| Auth provider | `auth.identifier`, `auth.parse`, `auth.refresh` | Implemented |
| Model registrar | `model.register` | Implemented (config-backed catalog) |
| Executor (chat, non-stream) | `executor.identifier`, `executor.execute` | Implemented |
| Device login | `auth.login.start`, `auth.login.poll` | **Not implemented** (explicit 501) |
| Streaming inference | `executor.execute_stream` | **Not implemented** (explicit 501) |
| Token counting | `executor.count_tokens` | **Not implemented** (explicit 501) |
| HTTP passthrough | `executor.http_request` | **Not implemented** (explicit 501) |

Details:

- **Credential parsing** (`auth.parse`): recognizes a Cline credential file of
  the shape `{"accessToken","refreshToken","expiresAt"}` (the same shape the
  gateway adapter persists, so an existing credential file is reused without a
  second credential owner). Foreign payloads are reported unhandled so other
  parsers can run.
- **Refresh owner contract** (`auth.refresh`): the host's own auto-refresh loop
  is the single sequential refresh owner; the plugin rotates the credential via
  `POST {api_base_url}/api/v1/auth/refresh` through the host HTTP transport
  (`host.http.do`), retains the previous refresh token when the response rotates
  only the access token, and returns `NextRefreshAfter` = expiry − 5 min
  (configurable). A 401/403/429/402 refresh outcome is terminal and is never
  retried by the plugin.
- **Request translation** (`executor.execute`): maps public `cline/` model ids
  to upstream ids, floors `max_tokens`/`max_completion_tokens` at 64, preserves
  every other JSON field untouched, sends with the `workos:` bearer prefix and
  the Cline client headers, and unwraps `{success,data}` response envelopes.
  Unregistered models fail 404; missing credentials fail 401.
- **Error taxonomy**: the gateway's `classifyClineUpstreamError` contract
  (`cline_auth_error`, `cline_daily_free_quota_exhausted`, `cline_model_retired`,
  `cline_request_rejected`, `cline_upstream_error`) is preserved so quota and
  cooldown semantics stay identical to the validated adapter.

## Build

Requires Go ≥ 1.22, gcc (CGO), linux (or darwin) — same constraints as the
upstream plugin loader (`internal/pluginhost/loader_unix.go`).

```bash
cd plugins/cline
go build -buildmode=c-shared -o cline.so ./cmd/cline-plugin
go test ./...
```

The output `cline.so` exports `cliproxy_plugin_init`, `cliproxyPluginCall`,
`cliproxyPluginFree`, `cliproxyPluginShutdown` (ABI v1). Name the artifact
`cline.so` or `cline-v0.1.0.so` and place it in the configured plugins
directory (host naming rules: `internal/pluginhost/platform.go`).

## Host configuration (v8 layout)

```yaml
plugins:
  enabled: true
  dir: ./plugins
  configs:
    cline:
      enabled: true
      # api_base_url: https://api.cline.bot     # default
      # workos_base_url: https://api.workos.com # reserved for the login slice
      # refresh_buffer_ms: 300000               # default 5 min
      models:
        - id: gpt-x
          display_name: GPT X
```

A credential file (`cline.json`) with `{"accessToken","refreshToken","expiresAt"}`
is parsed by `auth.parse`. There is **no** login flow in this slice: produce
the credential file with the existing gateway OAuth flow and keep exactly one
refresh owner at a time.

The executor declares input/output format `openai` (chat-completions) and model
scope `oauth`, so the host binds it to the credential's published models and
performs any client-protocol translation itself.

## Interface integration status

- Registration envelope, capability flags, RPC method names, request/response
  field names, and `[]byte` base64 encoding follow `sdk/pluginapi/types.go`,
  `sdk/pluginabi/types.go` and `internal/pluginhost/rpc_client.go` at `v8.0.49`
  (schema version 10).
- **Verified by focused tests only.** The plugin has NOT been loaded by a live
  CLIProxyAPI host yet — that is the next integration step (staged, offline,
  credential-free; the parent deploys after review).
- Upstream host behavior (cooldown persistence, dispatch accounting, retry
  ceilings) is the host's responsibility and configured at the platform level
  per the gateway refactor plan; this plugin does not add a second owner for
  any of those concerns.

## Current limitations

1. No device login: `auth.login.start`/`poll` return 501; credentials come from
   the existing gateway OAuth flow.
2. Non-streaming chat only. `executor.execute_stream` returns 501 — no SSE
   bridging via `host.stream.emit` yet.
3. No token counting or HTTP passthrough.
4. Per-credential proxy (`AuthData.ProxyURL`) is not yet applied to upstream
   calls; the host transport already honors its own proxy policy.
5. The static catalog is config-declared (fixtures), not discovered from the
   Cline recommended-models feed — discovery is a later slice and must stay
   non-inference.

## Next small step

Load the built `cline.so` into the credential-free staged CLIProxyAPI 8.0.49
instance (parent-deployed), assert `plugin.register` → `auth.identifier`
handshake and `model.register` publication through the management API, and add
`executor.execute_stream` via the host stream bridge.
