# OpenCode Console plugin (CLIProxyAPI v8.0.49)

Corrected implementation slice for the OpenCode Zen provider at the
provider/executor level of the pinned mainline
[router-for-me/CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)
`v8.0.49` dynamic plugin host. It supersedes the REVIEW-REJECTED candidate
`f49de3d`/`f0cc3be` (not integrated, not deployed): every ported behavior is
pinned to the actual OpenCode source per file in [SOURCE-PINS.md](SOURCE-PINS.md).

This plugin is a native CLIProxyAPI plugin only. No standalone proxy, no
sidecar, no helper process, no second gateway. All upstream HTTP goes through
the host HTTP bridge (`host.http.do` / `host.http.do_stream`).

## What is implemented

| Capability | RPC methods | Status |
| --- | --- | --- |
| Registration (c-ABI v1, schema_version 10) | `plugin.register`, `plugin.reconfigure` | Implemented |
| Auth provider | `auth.identifier`, `auth.parse` | Implemented: the native `Credential.OAuth` shape (`type/methodID/access/refresh/expires/metadata`), fail-closed, foreign payloads declined |
| OAuth refresh | `auth.refresh` | Implemented as a narrow port of the native grant (`POST {server}/auth/device/token`, `client_id=opencode-cli`); 400 `invalid_grant` is the terminal native SignedOut, never retried |
| Model catalog (OAuth scope) | `model.register`, `model.static`, `model.for_auth` | Implemented: the configured bare-id allowlist, published only for a usable credential |
| Executor (chat, buffered) | `executor.identifier`, `executor.execute` | Implemented |
| Executor (chat, streaming) | `executor.execute_stream` | Implemented: async relay through `host.stream.emit`/`host.stream.close` with structured error detail |
| Console API passthrough | `executor.http_request` | Implemented, bounded: GET-only, limited to the credential's Console server, with the native Console headers (`x-org-id` from credential metadata) |
| Device login | `auth.login.start`, `auth.login.poll` | **Not implemented** (explicit 501): a login here would create a second refresh owner; seed the auth-dir credential from its existing single owner |
| Token counting | `executor.count_tokens` | **Not implemented** (explicit 501): no fabricated counts |

## Honest boundaries (not gaps that silently fall back)

- **Session identity is required and never minted.** The OpenCode free tier
  serves a request whose `x-opencode-session-id` / `x-session-affinity`
  headers name a session a real OpenCode runtime created. A native session is
  created by the native runtime's `Session.create` (project resolver, event
  bus, session store) — none of which a CLIProxyAPI dynamic plugin can host.
  This plugin therefore does NOT generate `ses_` ids. It accepts only a
  caller-supplied native-shaped identity (the conversation's actual OpenCode
  session id via host metadata or request headers) and otherwise fails the
  dispatch with HTTP 428 and the exact gap instead of fabricating a
  client-looking identity. Minting one was the rejected candidate's central
  defect.
- **Org identity is never injected.** `x-org-id` comes only from the
  credential's recorded metadata and is sent only on Console API calls
  (config discovery, the bounded GET passthrough), matching the native
  `console-access.ts`. Native inference requests carry no org header.
- **The user agent reports configured runtime identity**, not a fabricated
  one: `opencode/<channel>/<version>/<name>` from the plugin configuration,
  which must describe the OpenCode runtime this deployment actually
  represents (default `2.0.32/latest/cli`, the working server's version).
- **Expiry is admitted before dispatch.** An expired (or expiry-less) access
  token fails locally with a precise message about the single refresh owner;
  it never burns an upstream 401.
- **Refresh ownership stays singular.** The host's own auto-refresh loop is
  the single sequential owner; this plugin performs the grant rotation on its
  behalf and returns the rotated credential. Implementing the grant does not
  activate a token owner: activating an existing credential into this host
  requires the separate staged handoff.
- **No reasoning replay coverage yet.** Reasoning fields pass through
  untouched on both the request and response paths, but this slice has no
  reasoning-preservation fixtures specific to this plugin. Missing live
  reasoning replay remains untested, never claimed.
- **No tool execution.** Caller tool schemas pass through byte-for-byte; the
  caller owns execution. The plugin never injects fake tools and never adds
  manual header workarounds.
- **No live inference was run** to build or verify this slice, and none is
  authorized by it. All existing cooldowns, consumed IDs and the exclusive
  refresh ownership remain binding. The unresolved OpenCode 429 is untouched.

## Build

Requires Go ≥ 1.22, gcc (CGO), linux (or darwin) — the same constraints as the
upstream plugin loader.

```sh
cd plugins/opencode
go build -buildmode=c-shared -o opencode.so ./cmd/opencode-plugin
go vet ./...
go test ./...     # focused offline unit tests; fake transports only, no network
```

The output `opencode.so` exports `cliproxy_plugin_init`, `cliproxyPluginCall`,
`cliproxyPluginFree`, `cliproxyPluginShutdown` (ABI v1).

## Register and configure

Place the built `.so` in the host's plugin directory and configure it under
`plugins.configs.opencode`:

```yaml
plugins:
  enabled: true
  dir: "plugins"
  configs:
    opencode:
      enabled: true
      inference_base_url: "https://opencode.ai/inference/openai/v1"
      models:
        - beam-free
        - glm-5.3-flash-free
      app_name: cli
      version: "2.0.32"
      channel: latest
      project_id: global
```

Credential seeding is an operator action: place the OpenCode OAuth credential
JSON (the native `Credential.OAuth` shape — `type: "oauth"`,
`methodID: "device"`, `access`, `refresh`, `expires` ms epoch, `metadata`
with `server`/`orgID`) in the host auth dir. This plugin parses it and never
writes, copies or rotates it outside the host-owned refresh flow.

## Exact remaining blockers

1. **Live acceptance** — the provider's quota restriction (the recorded
   FreeUsageLimitError 429s and cooldowns) is external and unresolved. This
   plugin does not claim any live inference works.
2. **Native session lifecycle** — requests must arrive naming an
   actually-created OpenCode session. Until a native OpenCode runtime creates
   and forwards session ids (or the gateway sends the conversation's real
   session id), dispatches fail closed with the 428 gap error by design.
3. **Refresh-owner handoff** — activating the existing credential's refresh
   ownership into this host is a separate staged procedure (stop/lock
   verification, rollback, explicit labels). This plugin implements the
   grant; it does not perform the handoff.
4. **Reasoning replay fixtures** — the next slice candidate, together with a
   live-authorized request/reply capture.
