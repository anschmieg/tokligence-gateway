# OpenCode 0.3.0 pre-live audit — CLI signature before live testing

Parent disposition (0.3.1 candidate): verified F1 extension/finish-alias and
F2 token-field findings against the pinned native source. Implemented permissive
choice/delta extensions, reasoning_text, nullable optional identity metadata,
normalized finish aliases, and explicit frozen max_tokens_field policy with
the native opencode.ai default max_completion_tokens. Dual limits still fail;
no limit is invented. Focused regressions and the complete module race suite
and vet pass. Identity consistency/types and rejection of legacy executable
function deltas remain deliberate boundaries, as do opaque reasoning-details
replay, parent/fork lineage, tracing and dynamic Console compatibility ingestion.
Do not call this universal request/TLS parity or an explanation for429.

User confirmed real OAuth login. Read-only runtime comparison established it is
the same account/org/server as the old quarantined record. The durable ledger
still blocks inference until 2026-11-03T07:42:08.980115+00:00; the new login was
disabled for inference without deleting its grant. No live test or cooldown
reset occurred. The plan below is historical audit advice; execution must pin
the final tested/deployed0.3.1 artifact and current admission state, not reuse
the0.3.0 hash merely because authentication succeeded.

Date: 2026-11-02. Auditor scope: Read/Edit/Write only. No commands, no builds, no
tests executed, no network, no provider traffic, no credential/secret reads.
Files owned by this audit: **only this document**
(`docs/design/opencode-030-prelive-audit.md`). `plugins/opencode/*` is
parent/public-helper-child owned and was **not** edited.

## 1. Sources read in full (provenance of every claim below)

Go plugin (`plugins/opencode/`): `handler.go`, `credential.go`, `request.go`,
`response.go`, `transport.go`, `registry.go`, `config.go`, `device_login.go`,
`login_handler.go`, plus supporting `endpoint.go`, `errors.go`, `models.go`,
`sessionid.go`, `SOURCE-PINS.md`.

Pinned native working source (2.0.32, `/tmp/opencode-2032-parity`, archive
SHA pinned in `plugins/opencode/SOURCE-PINS.md:7`):
`packages/core/src/plugin/provider/opencode.ts`,
`packages/core/src/session/model-request.ts`,
`packages/core/src/session/affinity.ts`,
`packages/core/src/model-resolver.ts`,
`packages/ai/src/protocols/openai-chat.ts`, `packages/ai/src/protocols/zai-chat.ts`,
`packages/schema/src/config/provider.ts`, `packages/schema/src/project-id.ts`.

Repo-local compiled-native-models reference: `native/opencode/official-models.json`.
Historical wire evidence (already recorded, not re-measured):
`native/opencode/LIVE-ACCEPTANCE-PLAN.md`, `native/opencode/AUTONOMOUS.md`,
`native/opencode/README.md`, `docs/design/gateway-mvp-overnight.md`.

Deployment facts supplied by the operator and consistent with the checkpoint
(`docs/design/gateway-mvp-overnight.md:11`): OAuth plugin 0.3.0 deployed, source
`8b7b9ee`, plugin SHA `65eb953a979c6cfd66e83b68445236e77982db12f9d650055ee5d189eb98be66`;
exact candidate native.4 fake-TLS Console OAuth test PASS; user confirms the real
Console device-flow login succeeded. The old OpenCode credential is quarantined
(disabled) with a durable 429 cooldown whose recorded reset is Nov 3
00:00:00.977592183Z or later; it has not expired. **A successful login and a new
test request do not themselves prove the free-tier provider queue is ready. No
claim of universal parity, no “99.99 %”, and no cause attribution for the
recorded 429 is made or implied anywhere in this document.**

## 2. Proven request-path map (plugin ↔ pinned native source)

All claims carry file:line proof. Column “native” = pinned 2.0.32 source.

| Aspect | Plugin | Native proof | Verdict |
| --- | --- | --- | --- |
| Inference endpoint | `InferenceBaseURL + /chat/completions` (`request.go:138-147`); HTTPS-or-loopback-only guard (`endpoint.go:12-34`) | `DEFAULT_BASE_URL`/`PATH` (`openai-chat.ts:34-35`); free-tier api `https://opencode.ai/inference/openai/v1` (`native/opencode/official-models.json:9`) | Match |
| Auth header | `authorization: Bearer <access>` (`credential.go:120-125`), wired at `handler.go:625` | OAuth access through `nativeCredentialSettings`→bearer (`model-resolver.ts:308-329`) | Match |
| Session headers | `x-opencode-session-id`, `x-session-affinity`, `X-Session-Id`, `x-opencode-session`, `x-opencode-project`, `x-opencode-client`, UA (`request.go:57-68`) | same block (`model-request.ts:281-293`) | Match (absences see F3/F4) |
| User agent | `opencode/<channel>/<version>/<name>` from operator config, name defaults `cli` (`request.go:35-41`, `config.go:59-81`) | `App.useragent` (`request.go:13` pin; `opencode.ts:192` Console sets UA) | Match in format; the concrete version string is an operator decision (§4 note) |
| Project | configured `project_id`, fallback `global` (`config.go:43-67`) | static `global` identity (`project-id.ts:7`; `model-request.ts:289`) | Match in shape; real sessions carry resolved project ids (F3) |
| Org on inference | NOT in base block; only via `console_headers` overlay, refused unless equal to credential org (`request.go:197-214`) | `x-org-id` is Console-API only (`opencode.ts:562-568`); staging Console 200 config GET returned `x-opencode-org-id` merged into inference (`gateway-mvp-overnight.md:150`) | Match with overlay |
| Console overlay hardening | auth/cookie/host/connection/content-length/transfer-encoding/proxy-authorization refused; CR/LF/NUL refused (`config.go:116-135`) | — | Correct fail-closed |
| Body compilation | preserves caller fields, forces `stream:true`, defaults `stream_options.include_usage:true`, sets `model`, strips `session`/`session_id` (`request.go:97-132`) | `stream` literal true (`openai-chat.ts:181,842`), include_usage when support detected (default true, `openai-chat.ts:759,843`) | Match |
| Model id | strips `opencode/` prefix (`request.go:75-81`) | catalog serves bare ids; public aliasing is host routing (`models.go:31-33`) | Match |
| Tool/reasoning preservation | caller tools/messages untouched (`request.go:94-96`); no tool injection | native preserves via lowering (`openai-chat.ts:552-665`) | Match in intent; plugin does not re-lower (host translator owns it) |
| Enforcement | exactly one of `max_tokens`/`max_completion_tokens`, positive ints, `n=1`, `include_usage` boolean (`request.go:162-190`) | native emits exactly one field (`openai-chat.ts:845-847`) | Consistent, plugin stricter on caller input |

## 3. Findings — blockers and risks, ranked by demonstrated risk

Each finding: proof (file:line), demonstrated risk, minimal correction, and the
offline-focused test the parent can run. Nothing below asserts a cause for the
recorded 429s.

### F1 — Response decoder is stricter than the native event schema (highest demonstrated risk)

**Proven difference.**
Native tolerates unknown fields: the stream delta/choice/event schemas are
`StructWithRest(..., [Schema.Record(...)])` — extra keys parse and are ignored
(`openai-chat.ts:250-289`). The native finish-reason map accepts `stop`/`end`
→stop, `function_call`/`tool_calls`→tool-calls, plus `length`, `content_filter`,
and treats `error`/`network_error` as events, never as local parse failure
(`openai-chat.ts:868-902`).
The plugin instead: rejects any unrecognized delta key (“unsupported delta
field”, `response.go:245-246`); accepts only `stop|tool_calls|length|content_filter`
(`response.go:253-256`) and finalizes only `stop|tool_calls` (`response.go:323-324`);
and additionally requires every top-level `id`/`model` to be a string and
`created` to be an integer, constant across frames (`response.go:158-171`).

**Demonstrated risk.** A physically successful upstream response can be failed
locally (502) *after* the provider served tokens: e.g. an upstream sending
finish_reason `end`, `function_call`, a new delta key, or a non-int
`created`/object `model`. That is real token/net-spend for zero result, on the
only credential we are allowed to use. Unknown is occurrence probability for
the current GLM/big-pickle gateway flavors (upstream state, not auditable from
here).

**Minimal correction** (parent-owned `plugins/opencode/response.go` + tests):
(1) treat unknown choice/delta keys as pass-through ignore rather than decode
failure, matching `StructWithRest`; (2) map `end`→`stop` and `function_call`→
tool-calls aggregation at decode; (3) keep fail-closed for malformed JSON,
identity change, and unsupported final reasons. Do not weaken tool-call
validation (`response.go:339-348`) or the DONE+EOF commit rule
(`response.go:362-409`).

**Offline tests (network-blocked, existing files under `plugins/opencode/`):**
extend `response_test.go` with (a) an extra unknown delta/choice key yields an
unchanged downstream chunk; (b) `finish_reason:"end"` finalizes as `stop`;
(c) `finish_reason:"function_call"` with complete tool deltas finalizes as
tool_calls; (d) malformed/identity-change cases still fail; (e) `error`-tagged
frames still classify via `ClassifyRejection` (`response.go:115-135`).

### F2 — Output-token field and Console compatibility overlay are inert (proven gap, unknown current consequence)

**Proven difference.** The native compiler selects the output-token field from
model compatibility, defaulting per provider/baseURL: for provider
`opencode` / baseURL `opencode.ai` the detector returns `max_completion_tokens`
(`openai-chat.ts:683-715`, selection at `820-821`, emit at `845-847`); explicit
compatibility overrides exist — e.g. the ZAI/GLM compatibility record pins
`maxTokensField: "max_tokens"` (`zai-chat.ts:65-71`, referenced as the GLM
compatibility at `request.go:15-16`). The Console overlay can carry per-provider
*and* per-model `compatibility` (`packages/schema/src/config/provider.ts:94,122`),
applied by the native transform (`opencode.ts:292-297,304`).
The plugin ingests only `console_headers` and `console_disabled_models`
(`config.go:17-21`) and forwards the caller’s field unchanged
(`request.go:97-132`); it cannot apply a Console compatibility change.

**Wire evidence for the snapshot models.** Repo-pinned compiled-native models
snapshot `native/opencode/official-models.json` is provider-scoped `opencode`
(line 2-10, api `https://opencode.ai/inference/openai/v1` line 9) containing
`beam-free` (11-61), `glm-5.3-flash-free` (62-111), `deepseek-v4.1-flash-free`
(112-164), `mimo-v2.6-flash-free` (165-205), each with `provider.api` per model
and **no compatibility block**. `big-pickle` is **not** in this snapshot; the
big-pickle evidence is from the compiled CLI 1.18.32 catalog/session inspection
(`native/opencode/AUTONOMOUS.md:296` — provider opencode, model big-pickle,
stop-finish, cost 0, interleaved `reasoning_content`). Field behavior actually
captured: the compiled native (2.x) compiler emits `max_completion_tokens`,
the official CLI 1.18.32 emits `max_tokens`
(`native/opencode/README.md:29`, `native/opencode/AUTONOMOUS.md:15`). Both
shapes historically succeeded upstream (the 1.18.32 big-pickle session above).

**Demonstrated risk.** If the currently deployed Console overlay sets
compatibility (or `supportsPromptCacheKey`, headers/body deltas) that differs
from the frozen Nov 2 snapshot (66 restrictions deployed,
`gateway-mvp-overnight.md:174`), the plugin silently diverges from the native
signature. Consequence unknown — not proven to be the 429 cause and not assumed.

**Minimal correction.** Either (a) record the accepted-policy decision: caller
field-name is forwarded, both fields have upstream precedent (evidence above),
and forbid a mixed auto-switch; or (b) add Console
compatibility→`maxTokensField`/`store` ingestion to the snapshot policy with the
same deny/allow fail-closed style. Option (a) is the smaller, deployable change.

**Offline tests.** `console_models_test.go` / `request_test.go` additions:
frozen-overlay digest change flips nothing silently (config refuses unknown
compatibility keys unless ingested); both accepted single fields map through
dispatch; simultaneous fields still 400 (`request.go:174-178`).

### F3 — Parent/fork affinity has no native analogue (proven structural difference)

**Proven difference.** Native sends `x-opencode-parent-session-id` and
`x-parent-session-id` for child sessions and sets `x-session-affinity` to the
parent/fork-source session id (`model-request.ts:283-291`;
`affinity.ts:6-8`: “children share the parent’s, forks the fork source’s”).
The plugin has no parent/fork concept: affinity = minted session id
(`request.go:49-51`), and no parent headers are sent. Session ids are minted per
(principal, conversation) (`handler.go:765-778`, `registry.go:389-440`) with the
exact native algorithm (`sessionid.go:100-138`).

**Demonstrated risk.** Multi-session families (subagents) will not share cache
affinity as the native CLI does; cache-hit/usage accounting may differ. Unknown
whether upstream dimensions quota or cache by this. Low severity, honest
disclosure required; do not attempt to fake parent links.

**Minimal correction.** Document the gap in the plugin README and the executor
contract; no code change. A later, separately owned change could map the host
conversation tree to the parent registry entry, but must not mint identities
from caller headers (`handler.go:599-605` rule stays).

### F4 — Tracing headers differ (proven, observed, low)

Real compiled-CLI captures show reference-only `x-opencode-request` and
native-only `b3`/`traceparent` (plus the session block) on actual requests
(`native/opencode/LIVE-ACCEPTANCE-PLAN.md:97`). The plugin sends neither
(`request.go:57-68`). Tracing alone is unlikely to be policy-relevant;
disclose, no correction for 0.3.0 (fabricating trace IDs would be worse).

### F5 — Device login org selection can diverge for mixed-case/multi-org users (low)

**Proven difference.** Native sorts orgs with `localeCompare` by name then id
(`opencode.ts:630`); the plugin sorts by plain `<` (`device_login.go:439-444`),
which is byte-wise and puts uppercase first where locale comparison is largely
case-folded. Different chosen org ⇒ different `metadata.orgID`/`orgName` ⇒
different `x-org-id` on Console calls and `x-opencode-org-id` overlay equality.

**Minimal correction** (parent-owned): replicate a case-folded ordering
(lower-case name, tie by id), add `device_login_test.go` case with names
`"a"` vs `"B"` proving identical selection to `a.localeCompare` semantics.

### F6 — Refresh/poll edge strictness (low, both already terminal-safe)

- Refresh: plugin classifies 400 as SignedOut on a substring
  `invalid_grant` anywhere in the body (`handler.go:450-455`); native matches the
  literal `{error:"invalid_grant"}` body only (`opencode.ts:155-157`). Broader,
  but both reactions are the same terminal SignedOut with no retry — safe, note
  only.
- Device poll: plugin refuses any status other than 400/2xx before union
  parsing (`device_login.go:302-307`); native parses the union regardless of
  status (`opencode.ts:594-617`, `post(..., statusOk=false)` at `658-669`). Both
  flows terminate; error text differs. No correction required for 0.3.0.
- Refresh metadata rotation and org-name fallback, expiry window
  (`expires <= now + 5 min`), and 5-minute `NextRefreshAfter` mirror
  `opencode.ts:148-180` and the integration expiring() window
  (`credential.go:180-213`); plugin correctly does not run its own refresh loop
  (`handler.go:27-32`), the host stays the single sequential owner.

### F7 — Explicitly NOT parity (honest boundaries; not blockers to the single request)

- `executor.count_tokens` is a deliberate 501, no fabricated counts
  (`handler.go:358-359`).
- Console dynamic transforms are static: no 60-second re-fetch of
  `/api/v2/config`, no `ManagedPolicy` (org policies) publication, no websearch
  or MCP attachment, no per-model vendors/variants/cost/limit/package ingestion
  (`opencode.ts:210-497`, `config.go:17-21`). The snapshot policy is
  deliberately narrow (`SOURCE-PINS.md:62-77`).
- Stream relay timing/schema strictness beyond native (F1).
- The `console_body` helper work is owned by the active child scope
  (`gateway-mvp-overnight.md:170-173`); this audit implements nothing for it.

## 4. Separating proven evidence from unknown current Console config

**Proven (source or already-recorded evidence, no new traffic):**
endpoint path, auth header shape, base session header block, UA format,
`stream: true` + `include_usage` default, exact single output-field emission,
credential shape/refresh grant/expiry window, device-flow start/poll/credential
sequence and org selection contract, registry/session-id algorithm and
partitioning, host transport/cancellation/DONE+EOF commit, Console overlay
header+denylist policy, native 2.x `max_completion_tokens` vs CLI 1.18.32
`max_tokens` captures, snapshot model list above.

**Unknown (must not be filled by inference):**
- The *current* content of the deployed Console `/api/v2/config` overlay
  (compatibility, per-model settings/headers/body/variants, policies,
  websearch/mcp entries): schema-availability is proven
  (`config/provider.ts:34-125`), the
  deployed values are not. Last proven observation is the Nov 2 staging GET
  (`gateway-mvp-overnight.md:150,167`).
- Whether the upstream’s quota/limit dimensioning keys on headers
  (org/project/affinity), field names, or tracing — never identified; no cause
  claim is permitted for the recorded 429s.
- The exact UA version string the operator wants the deployment to represent
  (`config.go:36-46` pins 2.0.32 by default; Console reads User-Agent for
  policy evaluation, `opencode.ts:190-192`). This is an operator decision, not
  a plugin defect.
- Whether free-quota is currently available (cooldown facts above; §6).

## 5. Public fallback: documented plan only (no implementation)

The native selection rule is pinned: a public/`"public"`-key path exists only
when there is **no** env key, **no** active connection, and **no** configured
key, and paid models are disabled when public (`opencode.ts:349-372`, verified
at `request.go:75-81` context and `gateway-mvp-overnight.md:19`). Therefore:

- An **existing** OpenCode connection (including the quarantined disabled one)
  suppresses public activation; the 429 quarantine is itself a suppression, and
  no auth-lane fallback may be created to escape it
  (`gateway-mvp-overnight.md:13`).
- The public fallback files (`plugins/opencode/public_credential.go` + tests)
  are owned by the active child scope `be254047-94cc-4dc4-9ab8-22b91a8c6b2f`.
  This audit creates no duplicate implementation; the documented sequence is:
  OAuth preferred → public only on proven credential *absence* → never on
  rejection, and only with the four-free-model allowlist and zero-audit of
  non-secret `host.auth.list` metadata.

## 6. Parent live acceptance plan — stable ID, prepared only (NOT executed)

This is a plan document. Nothing here was run and nothing here cancels dumb
cooldowns. **Stable ID: run `cliproxy-opencode-030-live-20261103-v1`, window
`cliproxy-opencode-030-window-20261103`** (never replayed after use, positive or
negative; all previous IDs/windows/reports remain consumed and immutable).

**Scope of the single admitted window (exactly, no more):**

1. One physical free provider request, model `glm-5.3-flash-free`,
   `max_tokens` (single field) = **1024**, `stream: true`, `n: 1`, no tools in
   the body, no reasoning-effort variant, no titles/compaction/parallel turns.
2. No auto-refresh, no retry, no redirects, no fanout, no provider fallback, no
   model matrix, no additional window, no follow-up on any outcome.
3. Exactly one active credential: the newly completed device-flow OAuth
   credential. The old 429-quarantined credential stays disabled; no rotation,
   no second owner, no bypass of the quarantine, no re-enable of the old
   credential under any outcome.
4. Runtime credential inspection and admission are **parent-owned** via
   non-secret native surfaces only (health, model publication,
   `host.auth.list`-class non-secret metadata, status/disabled flags). This
   audit reads no secrets, and the plan reads no token/DB values.

**Admission gates (all checked immediately before the single dispatch; any
failure ⇒ zero provider requests and window marked unexecuted):**

1. Plugin identity: deployed 0.3.0, plugin SHA
   `65eb953a…188be66` and source `8b7b9ee` match the deployment journal;
   health 200; old `.so` rollback retained.
2. Deployment revision chain includes the deployed Console overlay
   (`5aa1073`), model policy (`736569b1…`/source `3fccdb2`), redirect-disable
   and reasoning-compat backends (`.3`/`.2` SHAs in
   `gateway-mvp-overnight.md:138,160,167,174`), with the opencode provider
   configured **retry 0, redirects disabled, provider fallback false**
   (`gateway-mvp-overnight.md:115`).
3. Cooldown ledger: last recorded OpenCode rejection
   (`cliproxy-opencode-live-20261102-v1`, provider request
   `01a19b35-…`, recorded reset Nov 3 00:00:00.977592183Z or later) is intact;
   earliest eligible dispatch time **not before 2026-11-03T00:15:00Z**; the
   fixed timer is disabled; no later new rejection/cooldown is pending.
4. Credential admission (parent, non-secret): provider `opencode`, enabled,
   not expired and not due to refresh inside the window (host auto-refresh
   scheduling must not fire during the window; if `NextRefreshAfter` falls
   inside, postpone the whole window rather than refresh).
5. Config: `session_state_path` set for durable registry; provider create only;
   `inference_base_url`: pinned endpoint; allowlist for this window contains
   exactly `glm-5.3-flash-free`; `console_disabled_models` overlay preserved;
   `console_headers` snapshot present with org-equality property
   (`request.go:202-209`).
6. One dispatch mechanism: the accounted relay/worker counts the physical
   POST; assert **1 outbound request total** and, on completion or failure,
   persist: timestamp, model, HTTP status, `ClassifyRejection` code if any,
   provider request id (`errors.go:41-68`), retry-after if any, dispatch count.
   No request/response bodies or token values in any report.

**Outcome rules (binding):**
- Success ⇒ record evidence, review F1-relevant stream shape actually received
  (field names, finish reason) as a *read-only observation*, and end. Success
  does **not** authorize a burst, other models, tools, long outputs, or a
  second window; any next window needs a new recorded hypothesis and its own
  ID/budget.
- 401/403/429/5xx, malformed/timeout/uncertain delivery ⇒ stop all diagnostic
  inference, persist the sanitized result and cooldown, timer stays disabled.
  Expiry alone is never permission to re-probe.
- No account/IP/auth-lane changes as a response to any outcome; old quarantine
  is never lifted to compensate; public fallback not activated inside this
  window regardless of outcome (§5 suppression rule).

## 7. Findings and test admission conditions (closing summary)

**Findings, ranked:**
1. **F1 (high demonstrated risk):** plugin stream decoder stricter than native —
   unknown delta fields rejected (`response.go:245-246` vs
   `openai-chat.ts:250-272,282-289`) and restricted finish-reason set
   (`response.go:253-256,323-324` vs `openai-chat.ts:868-902`). Correct and test
   offline before live use.
2. **F2 (proven gap, unknown consequence):** output-token field and Console
   compatibility not ingested (`config.go:17-21` vs
   `openai-chat.ts:683-715,820-847`, `config/provider.ts:94,122`);
   snapshot models and captured field evidence differ per CLI generation
   (`official-models.json:2-205`, `native/opencode/README.md:29`). Decide and
   freeze policy; test both single fields through dispatch.
3. **F3 (structural):** no parent/fork affinity headers
   (`request.go:49-51` vs `model-request.ts:283-291`, `affinity.ts:6-8`).
   Document; no silent faking.
4. **F4 (observed):** tracing headers absent (opencode plugin vs
   `LIVE-ACCEPTANCE-PLAN.md:97`). Disclose only.
5. **F5 (low):** device login org selection ordering
   (`device_login.go:439-444` vs `opencode.ts:630`). Correct ordering offline.
6. **F6 (low):** refresh `invalid_grant` substring breadth and poll status gate
   (`handler.go:450-455`, `device_login.go:302-307` vs
   `opencode.ts:155-157,594-617`); both terminal-safe, note in tests.
7. **F7 (boundaries):** no count-tokens (501), static Console snapshot, no
   dynamic policies/websearch/MCP — must never be presented as parity.

**Test admission conditions** (offline; parent executes, this audit does not):
- T1: response tolerance suite (F1 corrections) passes, including unknown-key
  pass-through, `end`→stop, `function_call`→tool-calls, and unchanged
  fail-closed cases; DONE+EOF commit still rejects late frames.
- T2: token-field policy suite (F2) passes: exactly one field survives each
  accepted input; dual fields 400; frozen-overlay unknown compatibility keys do
  not silently change dispatch; `console_disabled_models` continues to gate
  publication and dispatch before HTTP.
- T3: device-flow offline suite extended for org ordering (F5) matches native
  selection on the mixed-case fixture, start/pending/slow-down pacing,
  access-denied/expired outcomes, replayed-state idempotence (existing
  `device_login_test.go` cases stay green, no runtime changes).
- T4: refresh/expiry suite: expired/expiring-in-window admission refuses
  locally with zero upstream calls (`handler_test.go` remains applicable);
  refresh grant body/headers/endpoint byte-equal to
  `opencode.ts:148-180`, `SignedOut` terminality preserved.
- T5: registry/integrity: caller-scope/conversation partitioning, lease
  protection, terminated-entry non-resurrection, crash recovery (existing
  `registry_*_test.go`, `session_test.go`) unchanged and green.
- T6: no secrets read by any test; no provider endpoints contacted; TLS/loopback
  guards (`endpoint.go:12-34`) asserted on every new test request shape.

**Live admission conditions** are §6, in full: stable ID
`cliproxy-opencode-030-live-20261103-v1`, exactly one physical free request,
`glm-5.3-flash-free`, `max_tokens`=1024, stream, no tools; all six gates pass
immediately pre-dispatch; no auto-refresh/retry/redirect/fanout/fallback/matrix;
old 429 quarantine preserved; parent owns runtime credential inspection; timer
disabled; outcome rules binding; success of this window proves only this window.

A new successful user-side login test (reported Nov 2) proves the OAuth
implementation works; it does not prove the upstream free queue, quota state, or
Console overlay content. Until a passing §6 window exists, OpenCode live
acceptance remains **INCOMPLETE**, by design.
