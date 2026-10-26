# Native OpenCode bridge (experimental staging)

This feature uses the pinned OpenCode **2.1.4** source (`68bc26b7da1990ce10ffecfbc1e09eb13aa5d824`) and Bun **1.4.4**. The source archive and SHA-256 are recorded in `source.json`. `scripts/prepare-opencode-native.mjs` verifies the archive, adds one internal request-preparation method, and copies this worker into the SDK package. Dependencies retain the upstream frozen lockfile.

The external caller owns its prompts, history, function definitions, tool execution, and agent loop. The worker uses OpenCode's actual embedded host, model resolver, provider plugins, OAuth credential store/refresh, session creation, request preparation, HTTP hooks, serializers, and LLM transport. Its internal `external` preparation seam skips agent context hooks that would append OpenCode identity/worktree instructions. This is a modified native harness, not a claim of byte-for-byte parity with every CLI agent request.

The gateway route is explicit: `opencode-native/<model>`. Set `OPENCODE_NATIVE_ENABLED=true`, `OPENCODE_NATIVE_URL=http://worker:4187/v1`, and a private `OPENCODE_NATIVE_KEY` shared with the worker. Existing canonical/profile routes do not include this lane. Disabled, incompatible, and failed native requests fail closed without legacy fallback. Provider OAuth tokens never enter the gateway. The gateway passes a principal/session-scoped affinity key; OpenCode generates native session and project headers.

## Build and verify

```sh
npm run prepare:native
cd .cache/opencode-native
bun install --frozen-lockfile --ignore-scripts --filter @opencode/sdk --filter @opencode/core --filter @opencode/server
cd ../..
npm test
npm run lint
npm run test:native
```

Use Bun 1.4.4. If source/Bun live elsewhere, set `OPENCODE_NATIVE_SOURCE` and `OPENCODE_NATIVE_BUN`. Ordinary unit tests skip the real-runtime fixture when these are absent; `npm run test:native` explicitly fails when prerequisites are missing. The runtime fixture starts the real pinned host against a loopback synthetic provider; it does not need or read production credentials. It exercises large prompts/answers, unchanged system prompts, native headers and stable sessions, parallel tool calls, tool results, reasoning replay, streaming, buffered completion, quota errors, and truncated output. Separate tests exercise the gateway Messages translation and native authorization boundary. Cancellation is checked against the real provider connection.

A separate image can be built from the repository root:

```sh
docker build -f native/opencode/Dockerfile -t tokligence-opencode-native:staging .
```

For upstream SDK typechecking, additionally install the root and script workspaces with the frozen lockfile (`--filter opencode --filter @opencode/script` alongside the filters above), then run `bun run --cwd .cache/opencode-native/packages/sdk typecheck`. This check passed with the overlay.

The Dockerfile is provided but has not been image-built in this environment; VPS verification uses the same prepared source and pinned Bun directly.

## Worker configuration

Run `native/opencode/run.sh` with:

- `OPENCODE_NATIVE_STATE`: isolated persistent directory; private permissions.
- `OPENCODE_NATIVE_SOURCE`: prepared source directory.
- `OPENCODE_NATIVE_KEY`: random internal bearer key, at least 32 characters.
- `OPENCODE_NATIVE_MODELS`: explicit comma-separated bare model allowlist.
- `OPENCODE_NATIVE_SEED_FILE`: optional initial OAuth JSON, inside the isolated state directory. The worker imports it once into its native database, then renames it `.imported`; an existing credential is never overwritten on restart.
- Optional `OPENCODE_NATIVE_BIND` (default loopback), `OPENCODE_NATIVE_PORT` (4187), `OPENCODE_NATIVE_BUN` (bun).

The runner sets all XDG locations inside the state directory. A process lock prevents two workers sharing that state. The real worker requires exactly one OpenCode credential; native model cost checks reject paid models. Seed credentials are forbidden in fixture mode. No tool execution is exposed. Four concurrent sessions are allowed, one request per native session, with a 120-second deadline and bounded event queue. The worker performs one native model attempt per request; the CLI caller controls retries. An upstream quota response is returned with its safe code, status, request ID, Retry-After and reset time, without raw credential-bearing upstream bodies.

Supported scope: text, function tools, textual reasoning, Chat Completions and gateway-translated Messages. Unsupported modalities, opaque metadata replay and strict function schemas fail explicitly. Authoritative end-text is preserved when it extends streamed text; revisions fail explicitly. Opaque signed/encrypted reasoning requires further replay support. Do not add this lane to automatic production fallback until the live matrix is complete.

## Staging handoff, October 26, 2026

Branch: `feat/opencode-native-bridge`. Production remains on `main`; no feature deployment was made there.

SSH: `ssh -F /home/t3/.ssh/fra-agent.conf fra-agent`. Staging root: `/home/agent/tokligence-staging`. Worker: `127.0.0.1:4187`; gateway: `127.0.0.1:4190`. These are private VPS processes, not public endpoints. Runtime source/Bun/Node live in `runtime/`; private `worker-env.json` and `gateway-env.json` contain service keys. Never print these files. Startup scripts and PID/log files are in the staging root. The processes survive SSH disconnects but are not registered as boot-time services; check health before the scheduled run. Never start a second worker before stopping the recorded owner.

Account ownership: **primary remains production; secondary belongs exclusively to staging**. A one-time Coolify helper moved `/data/tokligence/zen/secondary-oauth.json` to `secondary-oauth.staging-owned.json`, waited for old requests to drain, checked that the production path stayed absent, and created the private staging seed. The worker imported that seed into `state/opencode.db`. The helper is stopped (application `oh8tozq0mck0num725o748ds`); do not restart it. The held production file is an inactive backup, not an eligible production credential. Never restore it to the original filename or seed another refresh owner. Production's primary credential was untouched.

Synthetic runtime tests passed locally and on the VPS. Live direct-VPS native probes of `beam-free`, `glm-5.3-flash-free`, `deepseek-v4.1-flash-free`, and `mimo-v2.6-flash-free` all returned **429 FreeUsageLimitError** with a reset of **October 27, 00:00 UTC**. This does not prove the quota's exact account/IP scope or a punitive malformed-request policy.

A T3 task titled **Run OpenCode staging tests after quota reset** is scheduled for **October 27, 00:05 UTC** in this thread. The timer uses the daily fixed-time scheduler; its first action must disable itself, making this a single intended test round. Run a bounded sequential live matrix after reset: actual Claude Code, long prompts/responses, textual reasoning replay, caller-owned tools, parallel calls, and tool-result continuation across the configured free models. Stop requests for an account if a fresh quota response persists. Report blocked cases separately from successful validation. Do not change egress/accounts to circumvent limits.

Claude Code is installed privately as `runtime/claude`. Run it directly on the VPS: SSH TCP forwarding is **administratively prohibited** for this account. `claude-check.py` in the staging root is the working bounded probe; it loads the gateway key privately into the CLI child environment. The CLI reached the native model and surfaced `api_error_status: 429` / `FreeUsageLimitError` before reset. The prepared matrix is `native/opencode/live-tests.py`: run it directly on the VPS from the staging gateway checkout. It refuses traffic before 00:05 UTC, stops on a fresh 429, saves a private JSON report, and covers long input/output, parallel tools, reasoning replay, and actual Claude Code Read-tool continuations across the four free models. The old local tunnel-based probe is obsolete. Do not use production credentials to make staging tests pass. Cline testing needs its own refresh-ownership check before importing any existing account.
