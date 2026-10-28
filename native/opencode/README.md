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

Use Bun 1.4.4. If source/Bun live elsewhere, set `OPENCODE_NATIVE_SOURCE` and `OPENCODE_NATIVE_BUN`. Ordinary unit tests skip the real-runtime fixture when these are absent; `npm run test:native` explicitly fails when prerequisites are missing. Set `OPENCODE_NATIVE_CLAUDE_BINARY` to the installed Claude Code executable to also exercise the real CLI through gateway → native runtime → synthetic provider; this verifies failed-Read recovery, a successful Read, reasoning replay, inline system reminders and a long streamed answer. If omitted, that subtest is explicitly skipped. The runtime fixture starts the real pinned host against a loopback synthetic provider; it does not need or read production credentials. It exercises large prompts/answers, unchanged system prompts, native headers and stable sessions, parallel tool calls, tool results, reasoning replay, streaming, buffered completion, quota errors, and truncated output. Separate tests exercise the gateway Messages translation and native authorization boundary. Cancellation is checked against the real provider connection.

For an additional **official OpenCode CLI** capture, set `OPENCODE_OFFICIAL_CLI_BINARY` when running native tests, or run `python3 native/opencode/capture-official-cli.py --binary /absolute/path/to/opencode --output /new/empty/directory`. This Linux harness requires bubblewrap and has no unsandboxed fallback. It mounts only the executable, system runtime, fixture/helpers and private output; a network namespace blocks external traffic, and a supervised process group is cleaned up on exit. The actual OpenCode provider sends one accounted request to a synthetic loopback endpoint and receives a fixture response. External connectivity is checked as blocked, credentials are empty, tools/plugins/project config/catalog fetching/updates are disabled, and authorization values are excluded from artifacts. Output directories cannot be reused. Default model is the known-working GLM; `--model` selects another allowlisted free model. The current harness shares its exact profile builder and guarded relay with the public control below, uses cached public model metadata, and caps output at1024. The endpoint is a fixture and the catalog is pinned; this is not untouched live-default configuration.

Official CLI1.18.32 completed this capture in about 4 seconds using the AI SDK transport, public auth, and `x-opencode-request`/session/project/client headers. Native2.1.4 uses its own upstream request compiler, a different versioned user agent, additional affinity/session headers, and no V1 message-ID request header. These differences are expected across versions and are **not evidence that any particular difference causes quota rejection**. Do not spoof an old version's user agent or invent V1 message IDs in the newer runtime. Compare the actual provider paths further before deciding on a compatibility change.

A network-blocked capture through the real native `opencode` plugin (a diagnostic worker copy selecting `opencode` instead of generic `fixture`) confirmed a token-field difference: the native compiler sent `max_completion_tokens`, while official CLI1.18.32 and the available legacy Zen parser use `max_tokens`. The worker now selects `compatibility.maxTokensField: "max_tokens"` through the upstream provider configuration API. Native regression and real-provider capture verify a caller limit of1000 becomes `max_tokens: 1000` with no competing token-limit field. This preserves limits across older gateways; it is **not a proven cause or fix for the429**. No live inference was used to verify this change.

The available1.18.32 legacy Console server source contains an IP-based daily request limiter, optional model-specific buckets, and commented-out header-based fallback checks. Its handler can also route to a separate inference service. The deployed inference implementation/configuration and this VPS's counters are unavailable here; source evidence alone does not establish current quota scope or punitive treatment of malformed requests.

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
- `OPENCODE_NATIVE_AUTH_MODE`: `oauth` by default; explicit `public` uses the upstream plugin's built-in public access. Public mode requires a fresh separate state, zero OpenCode credentials and no seed/API-key/auth-content/Console-token overrides. An authentication-mode marker is checked before opening the host; modes cannot share a database. Public is never an automatic fallback after an OAuth rejection. Existing OAuth state migrates in place without altering its credentials.
- Optional `OPENCODE_NATIVE_BIND` (default loopback), `OPENCODE_NATIVE_PORT` (4187), `OPENCODE_NATIVE_BUN` (bun).

The runner sets all XDG locations inside the state directory. An OS-held `flock` on a retained file descriptor prevents two workers sharing that state, including across PID reuse and crash/restart. The lock inode is never removed; do not unlink `worker.lock`. The Linux worker requires the `flock` utility (included by the worker Dockerfile). The real worker requires exactly one OpenCode credential; native model cost checks reject paid models. Seed credentials are forbidden in fixture mode. No tool execution is exposed. Four concurrent sessions are allowed, one request per native session, with a configurable model deadline (120 seconds by default, up to 600 seconds via `OPENCODE_NATIVE_REQUEST_TIMEOUT_MS`) and bounded event queue. Body readers share that concurrency budget, enforce 16 MiB while reading chunked uploads, validate UTF-8 and have a separate 30-second upload deadline (`OPENCODE_NATIVE_BODY_TIMEOUT_MS`, maximum 30000). Model-deadline failures return a specific 504 diagnostic. Idle sessions expire after 24 hours; when the registry is full, inactive least-recently-used sessions are removed through the native session service. Allocation and eviction are serialized and active sessions are protected. `OPENCODE_NATIVE_SESSION_LIMIT` (default/max 4096) and `OPENCODE_NATIVE_SESSION_TTL_MS` (default 86400000, max 2592000000) can reduce these limits for tests. Legacy entries receive a timestamp on first load. Durable removal markers allow interrupted cleanup to resume. Native session IDs are allocated and journaled before idempotent native creation, so an interrupted create cannot orphan an identity. End-of-request timestamps are persisted through the serialized registry. The worker performs one native model attempt per request; the CLI caller controls retries. An upstream quota response is returned with its safe code, status, request ID, Retry-After and reset time, without raw credential-bearing upstream bodies.

Supported scope: text, function tools, textual reasoning, Chat Completions and gateway-translated Messages. Unsupported modalities, opaque metadata replay and strict function schemas fail explicitly. The Messages lane validates system prompts and nested tool-result content before translation; unsupported image/document/redacted-reasoning blocks are rejected rather than discarded. Tool-error flags are carried into native error results so callers can recover from failed tools. Inline system reminders from Claude Code retain their history position. Tool calls are withheld until a successful terminal event; length-limited and filtered completions preserve their status without exposing executable calls. Authoritative end-text is preserved when it extends streamed text; revisions fail explicitly. Opaque signed/encrypted reasoning requires further replay support. Do not add this lane to automatic production fallback until the live matrix is complete.

## Staging handoff, October 26, 2026

Branch: `feat/opencode-native-bridge`. Production remains on `main`; no feature deployment was made there.

SSH: `ssh -F /home/t3/.ssh/fra-agent.conf fra-agent`. Staging root: `/home/agent/tokligence-staging`. Worker: `127.0.0.1:4187`; gateway: `127.0.0.1:4190`. These are private VPS processes, not public endpoints. Runtime source/Bun/Node live in `runtime/`; private `worker-env.json` and `gateway-env.json` contain service keys. Never print these files. Startup scripts and PID/log files are in the staging root. The processes survive SSH disconnects but are not registered as boot-time services; check health before the scheduled run. Never start a second worker before stopping the recorded owner.

Account ownership: **primary remains production; secondary belongs exclusively to staging**. A one-time Coolify helper moved `/data/tokligence/zen/secondary-oauth.json` to `secondary-oauth.staging-owned.json`, waited for old requests to drain, checked that the production path stayed absent, and created the private staging seed. The worker imported that seed into `state/opencode.db`. The helper is stopped (application `oh8tozq0mck0num725o748ds`); do not restart it. The held production file is an inactive backup, not an eligible production credential. Never restore it to the original filename or seed another refresh owner. Production's primary credential was untouched.

Synthetic runtime tests passed locally and on the VPS. Live direct-VPS native probes of `beam-free`, `glm-5.3-flash-free`, `deepseek-v4.1-flash-free`, and `mimo-v2.6-flash-free` all returned **429 FreeUsageLimitError** with a reset of **October 27, 00:00 UTC**. This does not prove the quota's exact account/IP scope or a punitive malformed-request policy.

A T3 task titled **Run OpenCode staging tests after quota reset** is scheduled for **October 27, 00:05 UTC** in this thread. The timer uses the daily fixed-time scheduler; its first action must disable itself, making this a single intended test round. Run a bounded sequential live matrix after reset: actual Claude Code, long prompts/responses, textual reasoning replay, caller-owned tools, parallel calls, and tool-result continuation across the configured free models. Stop requests for an account if a fresh quota response persists. Report blocked cases separately from successful validation. Do not change egress/accounts to circumvent limits.

Claude Code is installed privately as `runtime/claude`. Run it directly on the VPS: SSH TCP forwarding is **administratively prohibited** for this account. The CLI reached the native model and surfaced `api_error_status: 429` / `FreeUsageLimitError` before reset. Use the guarded `native/opencode/live-tests.py` rather than the older `claude-check.py`/ad hoc probes for future inference. It requires a unique `--run-id`, obeys persistent cooldowns and explicit budgets, saves a private per-run JSON report, marks missing reasoning as untested (exit2 for incomplete coverage), and supports long input/output, parallel tools, reasoning replay, and actual Claude Code Read-tool continuations across the four allowlisted free models. The old local tunnel-based probe is obsolete. Do not use production credentials to make staging tests pass. Cline testing needs its own refresh-ownership check before importing any existing account.

## Guarded live probes

The default is **one GLM basic request with at most1024 output tokens**, not the whole matrix. After the recorded reset, a preflight can use:

```sh
python3 /home/agent/tokligence-staging/gateway/native/opencode/live-tests.py \
  --run-id glm-preflight-20261029 --not-before 2026-10-29T01:03:00+00:00
```

This does not change the staging worker's authentication mode. `--models` accepts only the four free IDs; `--phases` selects `basic,tools,long,claude`. Requests and reserved output tokens must fit explicit `--request-budget`/`--output-budget` values; a CLI request is capped at8192. Run small selected phases after a successful preflight, not repeated full matrices. The complete20-check coverage plan remains visible: omitted phases/models are untested, never passed.

`live_safety.py` holds an OS lock, reserves each run ID and each actual request before network I/O, and persists counts without credentials. Reused/crashed run IDs cannot be replayed. Existing historical quota reports seed the cooldown;401/403/429 persist a new cooldown (unknown resets conservatively stop for24h). Other upstream errors/redirects/transport failures stop that run. Historical reports are preserved; new evidence is `live-reports/<run-id>.json`, with accounting in `live-probe-ledger.json`. Do not delete these files to bypass a refusal. Ledger reservations are conservative requested limits, not measured billed usage.

Actual Claude Code calls pass through an authenticated loopback relay that enforces the selected model, budgets every inference including retries, rejects redirects and never forwards cookies/client authorization. Only a scoped Read fixture is permitted. The relay accepts the SDK's exact `beta=true` query, caps output, and serializes forwarding so a first quota rejection prevents simultaneous retries reaching the gateway. Its ownership lease remains held until forwarded work finishes; CLI process groups are reaped. Synthetic regressions cover crashes, concurrent owners/retries, quota import, model/auth rejection, budget exhaustion and redirect refusal. Real Claude Code/native-runtime regression also traverses this relay and verifies its request count against observed tool turns.

## Accounted official public control

After reset, use a stable identity for the single official-CLI GLM control:

```sh
python3 /home/agent/tokligence-staging/gateway/native/opencode/official-public-probe.py \
  --run-id official-glm-control-20261029 --not-before 2026-10-29T01:03:00+00:00 \
  --pause-staging --bun-transport /home/agent/tokligence-staging/runtime/bun
```

An explicit `--not-before` timestamp is required; the authorized next comparison is October29 01:03UTC. The same shared guard prevents replay, concurrent probes and calls during cooldown. The verified1.18.32 binary runs in an empty profile; no OAuth files or gateway credentials enter it. Its built-in public authentication is selected normally. Static `official-models.json` retains public metadata for four zero-cost aliases; only the output limit is reduced to1024. Tools, plugins, project config, updates, compaction and model fetching are disabled. The control admits exactly one selected-model Chat Completions request and forwards the original JSON/CLI metadata headers to the fixed HTTPS OpenCode endpoint, with normal TLS validation and no redirects/proxies/cookies. SDK retries are denied locally without further provider traffic. Inherited proxy configuration causes refusal, not an automatic egress change.

`--pause-staging` verifies recorded PID ownership (including relative script paths plus cwd), stops only those staging services to fit the1GiB user limit, then restores and checks their health in cleanup. Other processes, OAuth ownership and production remain untouched. Version/startup errors and timeouts preserve private diagnostics; per-run evidence lives under `live-reports/`. `--fixture-upstream` admits loopback `/v1` only and labels the result synthetic; it cannot choose another live origin. A successful control is not complete matrix coverage.

Scope limitation: this is the official CLI generating HTTP requests through a counted relay; The selected transport performs onward HTTPS (Bun in the command above; urllib when the Bun option is absent). It does **not** establish byte-for-byte or direct Bun-TLS parity. The report labels that transport explicitly. A rejection must not be described as an untouched direct-CLI result, and is not permission to retry unguarded. The network-blocked regression executes the real CLI through the same relay/profile and verifies one request, public auth, the model and exact token field.

## HTTP cancellation lifetime

The pinned Effect HTTP client can retain an unread response until GC when interruption lands after headers arrive but before a body reader is attached. The native worker now binds the final HTTP request to its model stream's scope through `scoped-http.ts` and the supported `HttpClient.withScope` API. Existing OpenCode HTTP hooks and the real transport remain in place. A deterministic regression holds the response strongly referenced: the old unscoped path stays open after interruption, while the scoped path closes before process teardown/GC and still runs a cloning HTTP hook. Repeated worker cancellation probes and real-CLI recovery tests retain their existing deadlines; no timeout was relaxed.

## Review fixes

The fixes are on `fix/opencode-native-review`, in an isolated worktree. The inherited feature tip contained an incomplete unrelated Cline adapter rename that prevented the gateway from starting. This fix branch restores the working bridge routing/configuration; the original shared checkout's concurrent work is preserved. Native lifecycle regression tests cover simultaneous cold starts, stale PID contents, SIGKILL recovery, and real native-session eviction. Wire/runtime tests cover both streaming and buffered filtered/length tool-call outcomes, including empty max-token completions through the gateway. A synthetic live-matrix run checks that absent reasoning and failed continuations cannot be reported as verified reasoning replay.

A second adversarial pass added a real-CLI synthetic end-to-end test. It exposed and fixed rejection of inline system reminders, rejection of tool-error results, and loss of empty `max_tokens` terminal semantics at the Messages gateway. The worker fixture also verifies cancellation after streaming has begun and immediate session reuse after cleanup. These checks do not consume live provider quota or replace the post-reset model matrix.

A further fault-path pass covers unknown-length upload bounds, stalled-body admission and cancellation, invalid UTF-8, duplicate tool results and conflicting history fields. Native lifecycle tests retry journaled creation after a process crash. A deterministic fault-injection test performs 80 interrupted operations/restarts and checks native identity bounds and absence of orphans. Streaming usage is opt-in; buffered accounting remains available. The live matrix checks all four models' short cases before quota-heavy phases, emits progress and permits longer bounded request/CLI durations. Staging uses a 600-second worker model deadline and 660-second gateway budget; the Python matrix waits up to 690 seconds per API call.

Upload rejection cancels the source immediately. Reading uses a bounded byte buffer rather than retaining per-chunk objects/promises, including for tiny fragments or a source whose cancellation never resolves. The real-CLI fixture includes an out-of-workspace secret canary: that read is denied and the allowed fixture read still succeeds. Live CLI runs use a scoped fixture Read approval, `dontAsk` and no permission prompts, following the [Claude Code permission rules](https://code.claude.com/docs/en/permissions). Staging's response-start budget is 650 seconds, inside its 660-second total gateway budget.

Cancellation finalization retains a session lease until the native request has stopped. A brief 409 during that interval carries `Retry-After: 1`. The idle timestamp updates synchronously when the lease is released; persistence remains serialized ahead of subsequent allocation, so filesystem latency does not unnecessarily hold a completed request active. The cancellation regression verifies bounded recovery rather than assuming peer socket close means every native finalizer has already completed.

The native verification script runs the expensive SDK fixture groups sequentially to avoid cold-start resource interference on small VPSs. The lifecycle fixture still starts competing owners concurrently, and the worker fixture still exercises simultaneous slow uploads. Cancellation probes use unique request markers, bind close observers to the matching provider request, and repeat five times before checking mid-stream cancellation.

Native Messages accepts an omitted `tool_result.content` as an empty tool result, matching the installed Anthropic SDK contract. Ambiguous non-text blocks with a string `text` field are rejected before the shared codec can reinterpret a tool or thinking block as plain text. Adapter regressions verify both behaviors at dispatch.

Messages `tool_choice.disable_parallel_tool_use` is preserved through OpenAI translation into native `disableParallelToolUse`. Unsupported tool-choice types, invalid flags and conflicting parallel settings return 400 before dispatch.

## Post-reset live result, October 27, 2026

The single-run schedule was disabled before execution. At 00:05 UTC, both staging services were healthy at `7e02c9b`, the worker held its exclusive lock and the production secondary credential path remained absent. The first `beam-free` basic request returned HTTP 429 `FreeUsageLimitError`, request ID `01a17aac-ff49-7ab9-bb6f-219e6b98be10`, with reset `2026-10-28T00:00:00.423Z`. The matrix stopped immediately; no other models, tool continuations, long cases or Claude Code live tests ran. No account or egress changes were made. This establishes a renewed quota rejection, not the quota's account/IP scope or its cause. Live compatibility remains untested.

The original private report retains this evidence, but its old `coverage_incomplete: false` field is incorrect for an early quota stop. The updated harness marks the interrupted check blocked, lists all remaining checks as untested, and reports incomplete coverage. A synthetic quota regression verifies exactly one provider call and all 20 coverage records. Do not rerun live traffic merely to regenerate this historical report.

Authenticated `GET /v1/diagnostics/models` on the native worker reports allowlisted resolved catalog model IDs, package, enabled/free flags and sanitized known-provider endpoint, plus auth mode. It does not prepare a turn or invoke inference, and does not expose credential settings. This distinguishes actual deployed model resolution from synthetic captures that override package/baseURL.

The official control optionally accepts `--bun-transport /absolute/path/to/bun` to forward its one guarded request using Bun.fetch instead of Python TLS. The private subprocess retains fixed destination/public auth, no redirects or retries, bounded I/O and deadline; the parent owns reservation/cooldown. Offline capture accepts the same option and blocks external networking. This removes one transport difference without claiming untouched compiled-CLI parity or a proven quota fix.

See [ADVERSARIAL-REVIEW.md](ADVERSARIAL-REVIEW.md) for the measured compatibility scope and remaining live gaps. Independent multi-turn compiler comparison is included in `test:native` when `OPENCODE_REFERENCE_SOURCE` (frozen installed1.18.32 source) and `OPENCODE_REFERENCE_BUN` (1.3.14) are supplied; hashes/version are checked against `reference-source.json`. The32 cases cover all four free models and require exact structural body equality. They do not establish full CLI/session/header/TLS parity. Live scripts now require an explicit `--not-before`; no implicit00:01 schedule remains.

The second review expands the independent differential test to **80 cases**, including system chronology, multipart messages and empty turns. The prepared AI compiler has a bridge-only `legacyMessageStructure` option; normal upstream defaults remain unchanged (101 upstream protocol tests pass). Preparation also generates `packages/sdk/src/tokligence-overlay.json`: copy all nine listed source files and that manifest as a bundle. The worker verifies them before creating its host and exposes the digest in health/headers, preventing partial deployments from silently changing requests.

## Reviewed single-request admission

Native requests now require an explicit stable conversation identity: `x-session-id`, `session-id`, `session_id`, `x-claude-code-session-id`, or Claude `metadata.user_id.session_id` (object or JSON string). Supplied identities must agree. Missing/conflicting identities fail locally; request IDs, task IDs, prompt cache keys and the legacy principal-wide default are not native conversation identities. The gateway hashes identity with the authenticated principal; the worker serializes the conversation across models and uses native switchModel. A new conversation ID starts an independent conversation; native fork lineage is not yet exposed. Same-ID continuations replay caller-owned complete history; cancellation does not roll back caller-executed tools. Idle TTL/LRU eviction removes the real local native session, not an invented remote close handshake.

The final model HTTP middleware preserves native fetch, headers, bodies, hooks and timeout settings while explicitly refusing redirects and allowing at most one physical fetch dispatch per completion. This intentionally differs from automatic redirect behavior in the default runtime. It prevents hidden redirect traffic, not provider-side quotas.

Live official controls require `--plan`. The prepared plan pins evidence and code hashes, the worker overlay, one stable run ID and an aggregate one-request/1024-output window. Replayed IDs, changed window limits, stale evidence, active probe owners, unhealthy/wrong service owners, missing worker flock, wrong auth mode, active cooldowns or early time refuse dispatch. A check-only command does not reserve the ID, stop services, or send inference:

```sh
python3 /home/agent/tokligence-staging/gateway/native/opencode/official-public-probe.py \
  --run-id official-glm-control-20261029 \
  --not-before 2026-10-29T01:34:00+00:00 \
  --plan /home/agent/tokligence-staging/gateway/native/opencode/staging-run-plan.json \
  --bun-transport /home/agent/tokligence-staging/runtime/bun --check-only
```

For the eligible scheduled control, replace `--check-only` with `--pause-staging`. The timer disables itself first. Success does not authorize another request in this window. Stop on rejection or uncertain delivery; no fallback/retry/account/IP rotation. The aggregate cap applies to controls admitted with this plan, not arbitrary gateway traffic; multi-run native matrix automation remains prohibited until it uses an equivalent shared admission budget.

`capture-official-cli.py --lifecycle` runs the actual compiled CLI with scoped Read permission in an OS network namespace. It captures parallel results, actual reasoning replay, process restart/resume, graceful cancellation/socket closure and resume afterward. Five actual CLI request bodies are replayed through the native compiler and compared exactly, in addition to the80 existing compiler vectors. It verifies stable session headers and classifies the current version-specific header names. Native additionally has tracing/session-affinity headers;1.18 has its own per-message request header. These legitimate differences remain visible, not spoofed. This is strong coverage of the declared synthetic lifecycle, not full live auth/TLS/process equivalence.

The preparation review additionally pins the exact staged CLI/Bun executable SHA256 and staging state/code root. Actual live controls require `--pause-staging`; alternate binaries/roots refuse admission. Readiness imports the same historical cooldowns as dispatch and checks spent/changed aggregate windows. Ledger writes sync the file before rename and sync the directory before forwarding. Native conversation identity is enforced again at the adapter boundary, including profile/alias routes.

The primary compatibility reference is now the same pinned2.1.4 core. `npm run test:native-api` runs114 native auth/config/model/request cases and bridge-specific comparisons in an OS network namespace with synthetic credentials. See API-BOUNDARY-REVIEW.md for all observed/API-visible action classes and intentional differences. User normal manual usage includes OAuth; current empty-profile observations do not establish historical request auth.

Explicit public mode now checks stored credential/account counts read-only before creating the host; a public marker alone is insufficient. The bridge also disables the SDK's automatic suspended-agent sweep through its supported SessionRestart override. Callers own continuation/tool execution; pending native claims are preserved rather than executed or deleted at boot. Session reference/create/remove journals sync both file and directory before native side effects. Readiness follows signal-handler installation.

Model admission now checks the native available-model list before per-model resolution and session mutation. Disabled models, any positive input/output/cache price, unsupported requested text/tools, and excessive output budgets fail locally. Invalid preflight requests do not extend session TTL. Required tool choice without declared definitions is invalid; a model without tools remains usable for plain text. Authenticated diagnostics expose text/tools capability flags and use the same price policy. Native catalog activation may still perform normal configuration/credential HTTP.
