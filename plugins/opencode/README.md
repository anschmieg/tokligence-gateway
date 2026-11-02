# OpenCode Console plugin (CLIProxyAPI v8.0.49)

**Current status (November 2): deployed with its credential quarantined after429.**
The historical review notes below predate completed host/session/reasoning tests
and the sequential credential handoff. Live acceptance still has not passed.
`console_disabled_models` applies the reviewed native Console model restrictions
to both publication and dispatch, intersecting the operator allowlist. It cannot
grant additional models. This is a snapshot, not automatic Console discovery.

Component tests/build do not establish working host dispatch. Blocking findings:
caller-scope/session behavior must still be verified through the real host. Console GET
passthrough now admits only the parsed same-origin native config path and never
copies caller authentication headers. Actual-host reasoning/tool continuation
fixtures remain required. Pinned stock host HTTP bridge follows redirects (http_bridge.go:
checkPluginRedirect); the plugin API has no no-redirect request option. One host
callback is therefore NOT proof of one physical request. Live admission requires
resolving this dispatch-budget gap without relying on redirect-free luck.

Parent lifecycle fixes: atomic registry acquire, idle TTL/LRU on reuse/release,
crash recovery clearing dead leases without changing IDs, strict persisted-state
validation, descriptor ownership, directory-sync error propagation, and refusal
after close/uncertain writes. Synchronous handler exits release leases and rejected
stream handles close. Missing transport returns503, never fake success.
Focused race tests include concurrent eviction, SIGKILL/reopen, persistence
failure and handler error exits. No real credentials or inference were used.

Reconfiguration is atomic and refuses active buffered/async requests; unchanged
state paths reuse their lock, failed acquisition leaves the old state untouched,
and replaced idle registries close. Refresh preserves the host credential ID,
metadata and attributes; foreign provider requests are rejected before HTTP.

Host transport now consumes the cgo shim's raw result exactly once and all HTTP
handler paths forward their per-request callback IDs. Stream handles close once;
cancellation closes the host stream even while stream_read is blocked, and
abandonment unblocks pending sends. Fake-RPC handler/bridge tests cover these
contracts, malformed results and pre-dispatch cancellation; actual-host smoke
is still pending.

Response paths share a bounded incremental SSE decoder. Streaming emits complete
`data:` frames and commits tool/finish/usage frames only after successful terminal
AND transport EOF; late failures withhold tools. Buffered calls return an assistant
`chat.completion` JSON response with text/reasoning, parallel tools and usage
aggregated. Truncation/filter/length/malformed/unsupported deltas fail explicitly.
Focused codec and actual handler tests cover these outcomes, fragmented UTF8,
reasoning text and bounded memory. This is fixture evidence, not live replay proof.

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
| Device login | `auth.login.start`, `auth.login.poll` | Implemented: native Console device authorization, paced host polling, user/org discovery and host-owned credential persistence/refresh. Existing account files are not overwritten by new logins. |
| Token counting | `executor.count_tokens` | **Not implemented** (explicit 501): no fabricated counts |

## Honest boundaries (not gaps that silently fall back)

- **Plugin-owned persistent sessions.** The registry maps a host conversation
  to a native-shaped ID using the pinned identifier algorithm. This is a local
  plugin mapping, not native database/event-bus lifecycle parity. No evidence
  establishes that the remote API requires native local session creation.
  Registry ownership uses only the host's authenticated `caller_scope` SHA256
  metadata (sdk/api/handlers requestCallerScope), never raw headers or upstream
  AuthID. Every dispatch, including native-looking conversation IDs, acquires a
  scoped registry lease. Different callers cannot bypass the registry with an
  identical header ID; changing upstream credentials does not change ownership.
  Focused tests pass; actual-host verification remains required.
- **Console provider headers are a separate native layer.** Console API calls
  use `x-org-id`; the actual Console configuration can additionally supply
  `x-opencode-org-id` for inference. `console_headers` holds that reviewed
  provider overlay. Its org value must match the credential metadata, or
  dispatch fails locally. Caller headers cannot replace it. This corrects the
  earlier false claim that the session header block was the whole header set.
  Current deployment uses a private Console snapshot; automatic overlay refresh,
  other model/body/package transformations are not implemented by this slice.
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
- **Synthetic reasoning replay verified.** The actual host/plugin continuation
  fixture preserves returned unsigned thinking with the explicit host compat
  setting. Live reasoning replay remains untested, never claimed.
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
Host file format is `{"type":"opencode","storage_version":1,"credential":{...}}`.
The nested value is native `Credential.OAuth` with type `oauth`, methodID,
access/refresh/expires/metadata. CLIProxyAPI forces the outer type to the provider
on save; nesting prevents that operation from corrupting the native discriminator
or account metadata. EncodeCredentialStorage emits this format for parse/refresh.
Bare native values remain accepted internally, but are not sufficient as a host
auth file. Flat legacy `type: opencode` credentials remain rejected. Focused fake
tests cover host metadata overlay, refresh rotation and watcher reparse; real-host
verification is still pending. Fake credentials only until blockers are fixed.

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

Dispatch-control admission rejects non-object payloads, invalid output-token
integers, simultaneous output-limit aliases, multiple choices (`n != 1`), and
malformed `stream_options.include_usage` before host HTTP. These are explicit
executor restrictions, not a complete native schema validator or a guessed
model limit. Valid limits are never clamped; unknown options remain intact.
