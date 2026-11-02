# OpenCode custom host integration smoke

The parent runs the actual mainline-based8.0.49 backend and compiled plugin
against a loopback mock inside `bwrap --unshare-net`. No real credentials,
provider network, existing state or unsandboxed fallback. A56-second supervisor
owns the entire process group and kills/reaps its descendants on every outcome.
Only runtime libraries/binaries/minimal identity files and a fresh private output
directory are mounted. Namespace identity must differ before any call begins.

The generated native v8 config enables a fake caller key, blank catalogs,
retry0/one credential, disabled panel updater, and the explicit plugin config.
Native metadata version updaters may attempt startup discovery; the namespace
blocks egress. No claim is made that all background HTTP is configurable off.
There are no real accounts or token refreshes in this fixture.

Custom cases:

- Provider-labelled envelope publishes `smoke-model` with nested native OAuth.
- Buffered Chat returns a normalized assistant completion including reasoning.
- Anthropic Messages emits translated `message_start` through `message_stop`.
- A reasoning-bearing assistant continuation must reach the next mock request
  as `reasoning_content`. Merely receiving reasoning/tokens is not replay proof.
- Exactly one mock POST per call, three total for the full continuation case.
- A separate raw-native credential-file control remains blocked, with zero
  publication/dispatch. This unsupported host-file shape is never a live fallback.

The fixture waits for asynchronous auth/model publication using bounded local
metadata reads; it never retries inference. Config is JSON (valid YAML) using
the pinned v8 hierarchy. No custom YAML serializer or legacy v7 fields.

Parent command (new empty output path; previous evidence never overwritten):

```sh
python3 plugins/opencode/testing/isolated_host_smoke.py --binary /tmp/cli-proxy-api-provider-budget --plugin /tmp/opencode-reviewed-response-build.so --output /tmp/opencode-host-smoke-example
```

Private evidence: summary.json, verdict.json, per-profile backend logs/configs,
fake auth state and generated fixture. Stdout is a sanitized verdict only.

Parent evidence November1:

- `/tmp/opencode-host-smoke-20261101-a`: initial zero-dispatch failure because
  metadata was checked before initial auth loading completed.
- `/tmp/opencode-host-smoke-20261101-b`: basic buffered+Messages cases PASS,
  two mock dispatches, enveloped publication and raw-native blocked control.
- `/tmp/opencode-host-smoke-20261101-c`: expanded continuation case FAIL;
  three single mock dispatches, but assistant reasoning was absent upstream.
  This is an integration blocker, not a live/provider result. The stock host
  translator's default Claude->OpenAI path filters thinking; its compatibility
  variant preserves it. A provider-level fix and rerun are required.
- `/tmp/opencode-host-smoke-20261101-d`: same failure using the EXACT returned
  assistant blocks reconstructed from SSE (no invented/replaced signature).
  The emitted thinking block is unsigned; the pinned normal request translator
  filters it, while its existing compatibility variant preserves it. Evidence
  includes the private stream response. Fix task is active; do not rerun unchanged.

No actual Claude Code client, tools, long response, live quota or universal
native-harness parity is claimed from these cases. Incoming session headers are
conversation references; the plugin now always uses its caller-scoped registry.

Targeted unload/reinitialization mode adds `--lifecycle-only`. It makes only
its two basic mock calls, then disables and re-enables the plugin through the
native management API with `If-Match`. It verifies descriptor-lock release
while the backend remains running and durable session identity after reload.
Its verdict explicitly marks reasoning replay **untested**, never verified.
`/tmp/opencode-host-lifecycle-20261101-a` passed this targeted mode; shutdown
unit tests additionally cover active-pump and synchronous-request draining.

Targeted `--tools-only` verifies two parallel lookup calls with interleaved
argument fragments, translated through the actual Messages endpoint. It feeds
back the returned assistant blocks and matching tool results, checks the mock
receives both original IDs/names/arguments/results, and requires one idle
registry session with zero leases afterward. Four mock requests total (the
two basic calls plus tool call/continuation); no real tool execution or file
access. Reasoning replay remains explicitly untested in this mode.
`/tmp/opencode-host-tools-20261101-a` passed the round trip; its persisted
registry also contains exactly one idle entry with zero leases.

`/tmp/opencode-host-reasoning-compat-20261102-a`: PASS full continuation using
8.0.49-tokligence.2 with explicit per-plugin preserve_unsigned_thinking. Actual
unsigned returned thinking survives the next provider request as reasoning_content;
three mock dispatches, no forged signature. This replaces c/d's known failing
host translation path; it is synthetic replay evidence, not live acceptance.
