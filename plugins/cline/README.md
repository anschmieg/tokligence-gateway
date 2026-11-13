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
| Model provider | `model.static`, `model.for_auth` | Implemented (per-credential publication) |
| Executor (chat, non-stream) | `executor.identifier`, `executor.execute` | Implemented |
| Device login | `auth.login.start`, `auth.login.poll` | **Not implemented** (explicit 501) |
| Streaming inference | `executor.execute_stream` | Implemented (wired, unit-tested; not yet live-host verified) |
| Token counting | `executor.count_tokens` | **Not implemented** (explicit 501) |
| HTTP passthrough | `executor.http_request` | **Not implemented** (explicit 501) |

Details:

- **Credential parsing** (`auth.parse`): recognizes a Cline credential file of
  the shape `{"accessToken","refreshToken","expiresAt"}` (the same shape the
  gateway adapter persists, so an existing credential file is reused without a
  second credential owner). A request routed to another provider is refused
  even when its file carries cline-shaped fields — claiming it would steal
  another provider's credential. Non-cline payloads are reported unhandled so
  other parsers can run. Auth IDs are namespaced per file (`cline:<file>`), so
  multiple credential files stay distinct identities and a re-parse of one file
  keeps the same ID.
- **Refresh owner contract** (`auth.refresh`): the host's own auto-refresh loop
  is the single sequential refresh owner; the plugin rotates the credential via
  `POST {api_base_url}/api/v1/auth/refresh` through the host HTTP transport
  (`host.http.do`), retains the previous refresh token when the response rotates
  only the access token, preserves the host-assigned
  `AuthID`/metadata/attributes (a refresh must never fork the credential into a
  second identity), and returns `NextRefreshAfter` = expiry − 5 min
  (configurable). A 401/403/429/402 refresh outcome is terminal and is never
  retried by the plugin. A refresh request naming a foreign auth provider is
  rejected before any upstream call.
- **Request translation** (`executor.execute`): maps public `cline/` model ids
  to upstream ids, floors `max_tokens`/`max_completion_tokens` at 64, preserves
  every other JSON field untouched, sends with the `workos:` bearer prefix and
  the Cline client headers, and unwraps `{success,data}` response envelopes.
  A `stream:true` request is rejected before any upstream call regardless of
  which executor method delivered it. An HTTP 2xx body that is malformed, or
  carries `success:false`, or is empty is an error — never a completion.
  Missing host transport fails closed (503) instead of returning a fabricated
  payload. Unregistered models fail 404; missing credentials fail 401.
- **Per-credential model publication** (`model.for_auth`): the host publishes
  credential-bound models through the model-provider capability when the
  executor scope is `oauth` (the registrar's static path is skipped for
  `oauth`-scoped executors). Answers only the plugin's own provider.
- **Endpoint safety**: configured `api_base_url`/`workos_base_url` must be
  HTTPS (loopback HTTP is allowed for isolated test deployments); anything else
  is rejected at registration/reconfigure time. Configuration is applied
  atomically: a rejected reconfigure leaves the previous state untouched.
- **Host callback context**: the per-call `host_callback_id` from each RPC
  request is forwarded on every `host.http.do` call so the host attributes the
  request to this plugin instance; no callback ID is kept in global mutable
  state.
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
- **Live-host verified (2026-11-01, credential-free, loopback-only):** the
  built `cline.so` was loaded by the pinned aarch64 `v8.0.49` binary
  (SHA-256 `685bbc0a…a5711b` per `checksums.txt`) on `127.0.0.1` with two
  **fake** credential files. Verified on the real host: `plugin.register`
  handshake, `/v0/management/plugins` registration
  (`oauth_provider: cline`), `auth.parse` of both files with distinct
  identities (`cline:cline.json`, `cline:cline-2.json`), ID stability across
  a file re-parse, `model.for_auth` publication of `cline/gpt-x` into
  `/v1/models` and the per-auth model list, and `executor.execute` failing
  closed with the upstream classification (502) using the fake token —
  with zero host-callback-context rejections (`host_callback_id` forwarding
  works). No real credentials or accounts were involved. Parent review found the test configuration targeted https://api.cline.bot and logs record an upstream response: this was an unplanned external fake-token call, not a fully local test or successful provider acceptance. Do not repeat it. Subsequent integration fixtures must use literal loopback endpoints with external networking blocked.
- Upstream host behavior (cooldown persistence, dispatch accounting, retry
  ceilings) is the host's responsibility and configured at the platform level
  per the gateway refactor plan; this plugin does not add a second owner for
  any of those concerns.

## Current limitations

1. No device login: `auth.login.start`/`poll` return 501; credentials come from
   the existing gateway OAuth flow.
2. Streaming chat: `executor.execute_stream` is wired end-to-end in-process —
   upstream SSE via `host.http.do_stream`/`stream_read`/`stream_close`, frame
   validation through the bounded SSE parser, delivery via
   `host.stream.emit`/`host.stream.close` with the host-allocated `stream_id`.
   Tool-bearing frames are withheld until a successful terminal
   (`stop`/`tool_calls`) AND transport EOF; `length`/`content_filter`, malformed SSE, upstream
   errors, and truncation close the host stream with an error and never
   release withheld calls. Frames use the complete SSE data framing required by
   the host Messages translator. Late post-DONE data/transport errors fail
   without releasing tools. Not yet exercised on a live host.
3. No token counting or HTTP passthrough.
4. Per-credential proxy (`AuthData.ProxyURL`) is not yet applied to upstream
   calls; the host transport already honors its own proxy policy.
5. The catalog is config-declared (fixtures), not discovered from the Cline
   recommended-models feed — discovery is a later slice and must stay
   non-inference.
6. The live-host verification covered registration, parse, model publication,
   and fail-closed execution with fake credentials only; a refresh cycle
   against the real Cline endpoint has NOT been exercised (no live account,
   by design) and awaits the parent's staged deployment.

## Next small step

Deploy the built `cline.so` into the parent's credential-free staged
CLIProxyAPI 8.0.49 instance, re-assert the registration/parse/publication
handshake there, and add `executor.execute_stream` via the host stream bridge.

Inference admission refuses expired access tokens locally on both buffered and
streaming paths. It does not refresh, switch accounts, or contact the provider;
the host remains the sole refresh owner. A foreign `AuthProvider` also fails
before transport. Focused tests cover the exact expiry boundary and zero host
HTTP callbacks on refusal. This is separate from live refresh acceptance.
