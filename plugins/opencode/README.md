# OpenCode Console plugin (CLIProxyAPI v8.0.49)

**Parent review: experimental candidate, NOT admitted for deployment.**
Component tests/build do not establish working host dispatch. Blocking findings:
host callbacks omit per-request callback IDs; the cgo shim/bridge envelope
contract needs reconciliation; stream close/cancellation and successful terminal
validation are incomplete; buffered execution returns SSE rather than a validated
completed response. Reconfigure must become atomic/concurrency-safe and reuse
the existing lock for an unchanged path. Trusted caller principal scope must be
proven through the host (auth-ID fallback is credential scope only). Console GET
passthrough currently uses unsafe URL-prefix validation and must be fixed or
removed before activation. Reasoning/tool continuation fixtures remain required.

Parent lifecycle fixes: atomic registry acquire, idle TTL/LRU on reuse/release,
crash recovery clearing dead leases without changing IDs, strict persisted-state
validation, descriptor ownership, directory-sync error propagation, and refusal
after close/uncertain writes. Synchronous handler exits release leases and rejected
stream handles close. Missing transport returns503, never fake success.
Focused race tests include concurrent eviction, SIGKILL/reopen, persistence
failure and handler error exits. No real credentials or inference were used.

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

- **Plugin-owned persistent sessions.** The registry maps a host conversation
  to a native-shaped ID using the pinned identifier algorithm. This is a local
  plugin mapping, not native database/event-bus lifecycle parity. No evidence
  establishes that the remote API requires native local session creation.
  Trusted principal/conversation binding still needs actual host verification.
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

Example only; do not activate this candidate yet. The eventual plugin goes under
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

Real credential activation requires a sequential verified refresh-owner handoff.
Never copy/reseed a live OAuth database or create a second owner for testing.
The parsed shape is native `Credential.OAuth`: type/methodID/access/refresh/
expires/metadata. Fake credentials only until integration blockers are fixed.

## Exact remaining blockers

1. **Live acceptance** — the provider's quota restriction (the recorded
   FreeUsageLimitError 429s and cooldowns) is external and unresolved. This
   plugin does not claim any live inference works.
2. **Host/session/stream integration** — resolve the blocking parent findings
   at the top of this file. The persistent registry is implemented, but this
   does not establish native harness or host integration parity.
3. **Refresh-owner handoff** — activating the existing credential's refresh
   ownership into this host is a separate staged procedure (stop/lock
   verification, rollback, explicit labels). This plugin implements the
   grant; it does not perform the handoff.
4. **Reasoning replay fixtures** — the next slice candidate, together with a
   live-authorized request/reply capture.
