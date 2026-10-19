# Cost and compaction architecture

Status: **phase 0 and phase 1 implemented; phase 2 gated.** Class routing is active for delegated/auxiliary turns and two role aliases are configured. Cold-resume routing remains evidence-gated as noted below.
Scope: how agent work is routed, and how long conversations are kept cheap,
across Claude Code, Codex CLI, OpenCode and T3 Code.

## 1. Goal

1. Strong models stay in charge while the quota they consume drops. The scarce
   resource is the ChatGPT subscription behind `codex-oauth`; the Mistral
   subscription and the OpenCode free tier are the overflow.
2. A conversation that goes quiet and is resumed later stops being expensive:
   whoever reads the expired history should be a free model where the harness is
   not already asking the provider for a summary, and the session should settle
   into a small ongoing prefix rather than re-sending itself turn after turn.

Constraint: both must work in every harness, not one of them.

## 2. Non-goals

- Compacting a session that is still being worked on.
- An always-on idle timer, a guaranteed cache-TTL value, or a
  resume-probability model in the first version.
- Replacing a maintained upstream component with a custom subsystem where the
  maintained one works.

## 3. What exists today (measured)

### 3.1 Front door and translation surfaces

The deployed gateway (`tgw-proxy.mjs`) is the only public HTTP service. It has
three distinct translation surfaces, not one:

| surface | who does it | notes |
|---|---|---|
| Messages <-> chat completions | `protocol-codecs.mjs` (~30 lines), `anthropic-openai-codec.mjs` (~350), `openai-stream.mjs` | makes `/v1/messages` universal: every provider that declares `chat_completions` is reachable through translation (groq, cerebras, together, nvidia, google, openrouter, nous, cline), and `modal` opts out with `messages_translation: false` |
| The Codex lane | **not gateway code**: `codex-oauth` is `adapter: oauth-proxy` pointing at CLIProxyAPI v7.3.20 on loopback | CLIProxyAPI owns OAuth, refresh, credential selection, session affinity, retry, the Anthropic->Codex translation, the Responses surface, and Codex remote compaction (`POST /v1/responses/compact`, plus the `remote_compaction_v2` `compaction_trigger` it does not yet answer - upstream issues #4848, #3085) |
| Anthropic pass-through, Zen gate, cline/copilot adapters, tokligence backend | gateway modules | `anthropic-passthrough.mjs` normalises non-conforming Anthropic responses |

Evidence: `gateway.routes.yaml:29-44` (provider, models, credential pool),
`:333-334` and `:348` (`gpt-5.6`, `gpt-6` prefixes; `codex-oauth: subscription`),
`tgw-proxy.mjs:863-870`, `:872-893` (`proxyToCodex`).

Gateway-side Responses handling is model-dependent. A Codex model is forwarded
verbatim by `handleCodexRoute` -> `proxyToCodex`, and `codexUpstreamUrl` keeps
the path, so `/v1/responses` and `/v1/responses/compact` reach CLIProxyAPI
untouched. Every *other* model falls through to `responsesPayloadToMessages`
(`tgw-proxy.mjs:1429`, `:1692`) and is served as a Messages call. An earlier
reading of this file claimed "CLIProxyAPI terminates the protocol" and concluded
the Codex lane could not compact; that was wrong in the way that mattered. The
lane does terminate the *Anthropic* translation, but it also serves the Codex
protocol natively and the compaction route was already reachable. What actually
blocked the lane was header stripping (5.2).

### 3.2 Prompt-cache affinity on the Codex lane

One identical 7,045-token prompt replayed through the gateway:

| what the request carried | turn 2 input tokens | cached |
|---|---|---|
| `x-claude-code-session-id` header only | 7,045 | **0** |
| `metadata.user_id` with `session_id` inside | **133** | **6,912 (98%)** |
| no session identity | 7,045 | **0** |
| `session-id` / `thread-id` / `prompt_cache_key` headers | 7,045 | **0** |

The gateway forwards only `accept`, `anthropic-beta`, `anthropic-version`,
`content-type`, `user-agent`, `x-request-id` to CLIProxyAPI
(`tgw-proxy.mjs:863-870`), so the session header never reaches the backend.
Affinity works **only** through the body's `metadata.user_id.session_id`.

### 3.3 What Claude Code sends

Captured from Claude Code 2.1.97 against a local mock (no config disturbed):

- `x-claude-code-session-id: <uuid>` header, and `metadata.user_id` decoding to
  `{device_id, account_uuid, session_id}` with the same uuid.
- `cache_control` present (the client marks its own cache breakpoints),
  3 system blocks, 84 tools.
- Two requests per turn (one streaming, one not).
- `anthropic-beta: claude-code-20250219,interleaved-thinking-2025-05-14,effort-2025-11-24`.

Conclusion: Claude Code's traffic is cache-affine through the gateway **today**,
because it sends `metadata.user_id`. Clients that send only the header are not,
and pay full price on every turn.

### 3.4 Request classes are available and partially used

Claude Code sends `x-claude-code-request-class` with one of `main`, `subagent`,
`workflow`, `compaction`, `auxiliary`, gated behind
`CLAUDE_CODE_GATEWAY_HINT_HEADERS=1`. It also sends `x-claude-code-agent-type`
(`Explore`, `fork`, `teammate`, `custom`) on delegated turns. The shared Claude settings and both gateway launch wrappers set
`CLAUDE_CODE_GATEWAY_HINT_HEADERS=1`. The gateway passes request-class and
agent-type hints into route planning. Class-based substitution is implemented
for delegated and auxiliary classes. It is now enabled against Mistral Medium
3.5, whose 256k window is documented upstream and clears the 128k profile floor.

### 3.5 Compaction primitives upstream

**Anthropic** exposes two distinct features that must not be conflated:

- **Context editing** uses `context_management` with the
  `context-management-2025-06-27` beta to clear old tool results or thinking
  blocks. It does not write a signed conversation summary.
- **On-demand summary compaction** uses the `compact-2026-09-04` beta and a
  top-level `compaction: {type: summarize}` request field. The API returns one
  complete `compaction` content block with text and a signature, and
  `stop_reason: compaction`. The client must preserve that block exactly and
  send the beta again on every later request carrying it. In a stream, the
  complete block arrives in `content_block_start` with no deltas. Top-level
  input/output usage is zero; the billed work is reported in `usage.iterations`.
  `compaction` and `context_management` cannot be used on the same request; if
  both are present, the gateway keeps the explicit summary request and strips
  `context_management` before forwarding.

Prompt-cache usage also has separate `cache_read_input_tokens` and
`cache_creation_input_tokens` fields; include them with input/output tokens when
estimating the next request's context size. The documented Anthropic cache TTL is
5m by default, with 1h behind `extended-cache-ttl-2025-04-11`; this is not a
cache-warmth signal for other providers.
**OpenAI**: `context_management: [{"type":"compaction","compact_threshold":N}]`
inside a Responses call, plus a standalone `responses.compact(model, input)`
whose `output` is passed forward as-is. For codex models the artifact is an
encrypted, provider-bound blob.

**ChatGPT/Codex cache TTL**: not published. Learnable per provider from the
cache counters every turn reports.

## 4. Decisions

| decision | choice |
|---|---|
| Front door | the deployed gateway, for every harness and machine |
| Claudex / shunt | stays shippable, out of the path; useful parts are candidates to fold in later |
| Codex lane | keep CLIProxyAPI. It already implements Codex remote compaction, so the transport swap is **not** justified by compaction. Fix the gateway's own pass-through and header forwarding instead; the swap stays a separate later decision, argued on continuation-delta economics, Codex CLI parity and routing reuse |
| Model selection | **class routing first** (request class + agent type), **role aliases later** |
| Provider compaction (Anthropic lane) | enable the beta **where the lane honours it** |
| Provider compaction (Codex lane) | pass `/v1/responses/compact` through; it makes Codex read the history, so here it is the fidelity option, not the cheap one |
| Harness compaction | warm cache -> the provider; cold cache -> a free/cheap model |
| Gateway-initiated compaction | cold resume only, and only if a spike shows the stored rewrite is worth it |
| Stored state at the front door | phase 0: session id + last-seen timestamp. Later, if needed: a bounded in-memory summary cache. Never a transcript, never on disk |

## 5. Design

### 5.1 One catalog, every harness

Every harness reads one catalog from `GET /v1/models` and its picker is
generated from it, so picks stop drifting between machines.

### 5.2 Affinity fix (do this first)

CLIProxyAPI derives its affinity key from the client's session headers, in its
own documented order: Claude Code `x-claude-code-session-id` (fallback
`metadata.user_id.session_id`), Codex `session-id`/`session_id` (fallback
`prompt_cache_key`), OpenCode `x-session-id`/`x-session-affinity`, pi
`x-client-request-id` (fallback `prompt_cache_key`). The front door forwarded
none of them, which is exactly why the measured fixture stayed cached only when
the identity was in the body.

1. **Done**: forward those headers to the self-hosted lane - `CODEX_FORWARD_HEADERS`
   on the direct path, `OAUTH_PROXY_FORWARD_HEADERS` on the routed one - and keep
   `openai-beta` symmetric with the `anthropic-beta` already forwarded. They go to
   CLIProxyAPI only; a session id is not handed to third-party providers.
2. **Done**: mirror `x-claude-code-session-id` into `metadata.user_id` when the
   client sends only the header, for lanes that read only the body
   (`synthesizeMetadataUserId` in `tgw-proxy.mjs`). Covered by a
   `proxy-integration.test.mjs` regression test.

Measured effect on the fixtures: 0 cached tokens -> 98% once an identity survives
the front door. More quota for a handful of lines than any routing cleverness.

### 5.3 Cheap-model selection: class routing first, role aliases later

**Phase 1 — class routing.** Use what the harness already sends
(`x-claude-code-request-class`, `x-claude-code-agent-type`); nothing is
configured per agent.

| class | cache warm | cache cold |
|---|---|---|
| `main` | session model | session model |
| `subagent`, `workflow` | cheap policy model (e.g. Mistral), fallback to the session model | same |
| `compaction` | the provider (see 5.4) | free/cheap model |
| `auxiliary` | free/cheap model | free/cheap model |

**Window floor.** A downgrade target must have a context window at least as
large as the model that was requested. Otherwise the client's view (window,
cost, when to compact) is wrong, and a long subagent can die on a backend-side
context error — a harness-visible failure. If no cheap target qualifies, keep
the session model and log the miss.

**Failure handling.** Any routing error or target failure falls back to the
session model. Routing must never lose a turn.

**Class routing state.** Opt-in model substitution is wired for `subagent`,
`workflow` and `auxiliary` request classes. The target is configured as
`classRouting.cheapPolicyModel`; candidate window metadata must be explicit and
at least the requested profile floor. Missing/undersized metadata is a no-op,
and the original profile chain remains after the target as fallback.
`classRouting.enabled` is true in the checked-in config and the target is
`mistral/mistral-medium-3-5` (documented 256k window). A target without verified
window metadata fails startup validation rather than degrading silently.
`main` and `compaction` remain on the ordinary route: warm/cold status is not yet
measured reliably enough to make the table's conditional compaction choice.
Direct Codex model requests (`gpt-6-sol` and friends) are not profile requests,
and their 1.05M window exceeds every configured cheap target, so the window floor
keeps them on their own lane.

**Phase 2 — role aliases.** The gateway now accepts role names such as
`model: role/review-strong` through the `roles` configuration. Each candidate
must name a configured provider/model, an explicit family, and a verified
context window; the published virtual model uses the **minimum window across
its candidates**. Candidate order uses current health/cooldown and quota state.
A bounded, in-memory family history keyed by authenticated session lets the
planner prefer a family not recently used by that session; if no diverse family
is available, role candidates remain available and the configured profile is
appended as a safe fallback. Two roles are configured: `role/review-strong`
(mistral, bonsai, gpt-oss) and `role/review-fast` (gpt-oss, ministral). Provider
model entries now declare `family`, which is what makes diversity measurable.

### 5.4 Provider compaction via the beta

Where the upstream is Anthropic-protocol and honours it, the client may send
the beta. The gateway currently implements route-gated pass-through only; it
does not synthesize beta headers or compaction request fields. It filters client
beta tokens against a provider-level
`anthropic_beta_allowlist`, strips paired `context_management` or `compaction`
fields when the corresponding beta is not admitted, and rejects allow-lists on
Codex, MiniMax (`tokligence`) and other translated adapters. MiniMax's official
Anthropic-compatibility docs state that `context_management` is ignored and do
not document on-demand compaction, so this route is explicitly ineligible; no
configured provider currently supports the compaction beta. A direct Anthropic
provider is not configured. The global Claude experimental-beta disable flag
has been removed; route policy, not a global client kill switch, controls
pass-through.

Sources: [Anthropic on-demand compaction](https://platform.claude.com/docs/en/build-with-claude/compaction-on-demand),
[MiniMax Anthropic SDK compatibility](https://platform.minimax.io/docs/api-reference/text-anthropic-api).

Rules:

- If gateway-side injection is added later, never synthesize `compaction` when
  the request already contains `compaction` or `context_management`; Anthropic
  rejects combining the two. Injection is not currently implemented.
- **Per-route allow-list.** The Anthropic compact beta is an Anthropic-server
  feature, so it belongs to Anthropic-protocol upstreams only. It is *not* the
  Codex lane's mechanism: that lane has its own, in the Responses protocol (see
  below). So the beta is never injected towards the Codex lane, and
  `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1` can be relaxed per-lane rather
  than globally.
- **Pass the outcome through untouched.** Signed `compaction` blocks and the
  `compaction` stop reason are first-class in the Anthropic normaliser; a
  regression test confirms the block, signature and usage survive unchanged.
- Where the client replaces its history with the returned summary, no state is
  stored anywhere.

Cost note: the beta makes the **provider** read the conversation. Warm, that is
a cache read. At cold resume it is a full-price read of the whole history; see
5.5.

**The Codex lane's own compaction.** Codex has a distinct pair of primitives and
CLIProxyAPI implements them: the dedicated `POST /v1/responses/compact`
(dispatched as the `responses/compact` operation) and, inside a Responses body,
`input[].type = "compaction_trigger"`. The pinned binary was inspected directly
and carries both routes, and the pin moved to 7.3.20 - the last 7.x, since 8.x
regrouped config.yaml under `server`/`access`/`oauth` while
`compileOAuthProxyYaml` still writes the flat 7.x schema. Two caveats remain:
the v2 `compaction_trigger` path is the one still reported broken upstream
(#4848), and a compact request forwarded to a provider without the
capability can 404, mark the credential unavailable and start a cooldown storm
that takes normal traffic with it (#4376). Enable it deliberately, not blanket.

The gateway's job here is only to stay out of the way: forward both routes for a
Codex model, keep the path intact (`endpointSuffix` no longer collapses
`/responses/compact` into `/responses`), and forward the session headers. That is
implemented and covered by `test/proxy-integration.test.mjs`.

One cost note specific to this lane: a compact request makes **Codex** read the
history, so it spends the scarce quota. It is the fidelity option on this lane,
never the cheap one; 5.5's free-model path stays the cost-optimal mechanism.

### 5.5 Cold resume: two mechanisms, one rule

**The rule: whoever reads the expired history should be the free model, unless
the harness is already asking the provider for a summary.**

| approach | who reads the history | Codex quota | who owns the compacted state |
|---|---|---|---|
| provider compaction via the beta | the provider | full price, once | the client |
| harness compaction, call routed to a free model | the free model | none | the client (its own transcript) |
| gateway rewrite with a free summariser | the free model | none | the gateway, in memory |

Implementation order:

1. **Route harness compaction calls to a free model when the cache is cold**
   (5.3), and let warm compaction go to the provider. Costs nothing, stores
   nothing, and works for every harness that compacts.
2. **Enable the provider beta where the lane supports it**, so Anthropic
   sessions get a provider-written summary rather than a cross-family one.
3. **Keep the gateway rewrite** (fingerprint-keyed, fail-open, memory-only) as
   the fallback for harnesses that never compact — and only if a spike shows it
   earns the stored state.

Open spike: whether a harness compacts *before* it sends its first real turn on
a cold resume. If it does, step 1 covers the case completely. If not, one
full-price turn escapes on the Codex lane.

### 5.6 Deliberately not done

- **No idle timer, no TTL guarantee, no P(resume) estimator.** Eager compaction
  would add a timer, per-provider TTL knowledge (exact only on Anthropic),
  stored windows, a probability model and per-harness hooks. Keep it as a
  documented later option if resume latency proves annoying.
- **No request rejection to force compaction.** It breaks the "never a
  harness-visible failure" criterion, and the discrimination between a long
  fresh request and a resumed session has no reliable tell. If the client should
  do the work instead, lower its auto-compact window rather than refuse service.
- **No summary round-trip invented by the gateway.** Client transcripts are
  append-only and there is no protocol field meaning "the server replaced your
  history". The only real round-trip is the providers' own compaction, which is
  why 5.4 exists.
- **No injecting the compact beta into lanes that cannot honour it** (the Codex
  lane), and no injecting it when the client already asked.
- **No replacing the chat-completions codec with shunt.** That surface is small
  and works; a Rust sidecar would need the same provider credentials and add a
  component without capability. The swap that would buy something is the Codex
  lane (CLIProxyAPI + transport -> shunt + `claudex-transport`), which is its
  own decision with its own costs: two binaries in the container, the ChatGPT
  device login moved inside it, a volume for transport auth state, Dockerfile
  changes.

## 6. Failure modes

| failure | behaviour |
|---|---|
| summariser slow or rate-limited | size floor and time budget; on breach, send verbatim |
| fingerprint mismatch (client compacted, rewind, fork) | drop the entry, send verbatim |
| gateway restart or deploy | in-memory entries lost; next cold turn re-summarises |
| provider rejects the synthesised metadata | fall back to forwarding the header only |
| cheap model unavailable, or no target meets the window floor | fall back to the session model; log the miss |
| an Anthropic compact beta aimed at the Codex lane | not injected and not honoured there; the lane's own `/v1/responses/compact` route serves the same need |
| a `/responses/compact` call routed to a provider without remote compaction | the upstream 404 can cool the credential down; forward only to lanes that advertise it |

## 7. Open spikes

1. **Answered, and it changed the plan.** CLIProxyAPI does expose
   `/v1/responses/compact` and the Responses compaction field, so the Codex lane
   is not a protocol dead end and the transport swap is not justified by
   compaction. The pinned binary was then inspected directly: it already carries
   `responses/compact` and the `compaction_trigger` handlers, so the pin moved to
   7.3.20 for the newer session-header preference. What remains is Codex CLI end
   to end through the gateway; the gateway-side pass-through is covered by a test.
2. Does a harness compact *before* its first real turn on a cold resume?
3. Can a harness be driven to compact headlessly? (`claude -p --continue
   "/compact"` returned exit 0 with no output and no distinguishable request on
   the wire.) Not a foundation until proven.
4. Does Codex CLI inbound parity matter? If yes, that is the strongest reason to
   host the Codex lane on shunt.
5. Exact cold threshold per provider, learned from cache counters. The gateway
   now captures bounded Codex session intervals and aggregate cache counters,
   but the Codex OAuth lane has no authoritative quota denominator in the
   gateway's `/admin/quota` API. OpenAI API cache-retention documentation is not
   evidence for ChatGPT subscription traffic through CLIProxyAPI. A controlled
   staged probe still needs a baseline quota reading and must stay within the
   user-approved 0.1–0.2% per stage / 1–2% total budget.

## 8. Phases

| phase | content | state stored |
|---|---|---|
| 0 | affinity and Codex compaction pass-through (done); Claude hint headers and beta allow-list implemented; MiniMax route explicitly ineligible per upstream docs; no direct Anthropic provider configured; class-routing foundation implemented but disabled pending verified target/window; aggregate and bounded session-interval cache measurement implemented, savings measurement pending | hashed session key in bounded memory; usage aggregates as before |
| 1 | role-alias framework, family diversity history, quota-aware ordering and minimum-window metadata implemented; no role candidate set is configured yet | bounded in-memory family history |
| 2 | cold-resume hardening: cache observation implemented; routing still gated until controlled sampling establishes a trustworthy signal; gateway rewrite only if spike 2 justifies it | no transcripts; session observation keys are hashed and memory-only; the existing aggregate usage store remains persistent |
| 3 (optional) | Codex-lane swap to shunt + transport; eager warm compaction only if resume latency warrants it | — |

## 9. Success criteria

1. Codex quota burn per representative week drops measurably (from
   `/admin/quota` and the usage endpoints, not from a feeling).
2. A cold resume stops the session from staying expensive afterwards, and where
   the lane allows it the provider writes the summary.
3. No new harness-visible failures, stalls or malformed turns in any of the four
   harnesses.
4. One identical, working catalog everywhere.
