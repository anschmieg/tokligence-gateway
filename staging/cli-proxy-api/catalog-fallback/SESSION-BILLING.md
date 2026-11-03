# Session billing and profile aliases

This is native CLIProxyAPI policy, using the existing inference authentication,
coordinator, credential owner and protocol handlers. Client installation is separate
from backend rollout; consult the checkpoint for the deployed artifact.

## Selection contract

| Permission | Admitted routes |
| --- | --- |
| FREE | Positively verified free-tier/source routes |
| SUB (default) | FREE plus verified included subscription allowances |
| PAID (explicit) | SUB plus PAYGO; unverified route economics remain UNKNOWN in telemetry |

Absent session policy defaults to SUB, including requests without session headers.
OAuth authentication, a model name and an unverified free-tier label are not cost
proof. Existing scoped no-charge allowances default to SUB; `billing-class: FREE`
is available only when the operator has actually verified a free-account allowance.
Account/source scope, disabled overage and expiry remain mandatory. Revocation is
checked at physical dispatch; no allowances are fabricated during deployment.

- `/chat/v1` and `/coding/v1`: requested model is preferred. Within each model,
  try eligible FREE, SUB, PAID routes in that order, according to permission.
  Exhaust that model before similarity-ranked alternatives. The original model
  remains the reference throughout. Native credential priority/weighting acts
  within a model/class; paid OpenRouter remains last in its class.
- Normal `/v1`: the model is binding; no cross-model fallback. Normal explicit
  provider overrides are also subject to billing permission.
- `:free` restricts one request to FREE, excluding SUB even when the session
  permits it. It cannot authorize PAID. On normal model IDs it cannot change the
  model; on a profile it permits similarity-ranked FREE alternatives.
- Virtual IDs **`chat`** and **`coding`** on the normal base explicitly select
  their respective profiles. `chat:free` and `coding:free` do likewise with FREE
  permission. They never shadow a registered real model. Standard OpenAI discovery
  advertises these aliases; protocol-specific curated lists retain native formats.
- Alias defaults are configurable with `preferred-model`. The rollout sets
  `nemotron-3.5-lightning` as the initial preference for both aliases. Clients
  selecting a profile URL can still specify their own different model preference.
  Chat uses general-task evidence, coding uses coding/agent evidence. Neither
  asserts a measured warmth/personality score; keep conversational style in the client.

Curation is independent of session spending permission; a displayed model may
need an alternative under SUB. Native capabilities, availability, evidence and
entitlement are rechecked. Missing evidence stays uncertain. Terminal/uncertain
errors and attempt limits stop continuation; committed streaming output never
changes route. Opaque state and compact requests require the exact preferred
model. Virtual aliases cannot identify an opaque/compact continuation's old model;
use its explicit resolved model instead.

`cost-policy: session` deliberately permits explicit PAID within these profiles.
A separately configured legacy `cost-policy: free-only` remains a hard no-added-cost
cap: inference rejects PAID with 403 rather than silently ignoring or bypassing it.

## Authentication, correlation and inheritance

Use the existing gateway inference key in `Authorization: Bearer ...`. Management
keys and Cloudflare browser cookies do not authenticate these APIs. Identity comes
from native authentication; no caller-supplied identity field is trusted.

Headers:

| Header | Meaning |
| --- | --- |
| `X-Gateway-Session` | Opaque stable session ID, required for session controls |
| `X-Gateway-Parent-Session` | Optional existing parent when creating a distinct child session |
| `X-Gateway-Request-Kind` | `main`, `subagent`, `compaction`, or `auxiliary`; omitted = `unspecified` |
| `X-Gateway-Prompt-ID` | Optional correlation ID; default is the generated request ID |
| `X-Gateway-Agent` | Optional agent ID |
| `X-Gateway-Parent-Request-ID` | Optional parent request correlation |

IDs are 1–128 ASCII letters/digits plus `.`, `_`, `:`, `-`, starting alphanumeric.
Duplicate/invalid correlation headers are rejected. Parent lookup is within the
same authenticated identity. Children can reuse the root session or link a distinct
session; subsequent child requests read the root's latest policy for that profile.
Unrelated sessions and other profiles retain their own default SUB. Every admitted
request snapshots all session policies once: a later change cannot broaden its
fallbacks, including on long streams. Runtime entitlement revocation still wins.

State is process-local, bounded to 4096 sessions / 128 per identity, expires after
24h idle, and resets conservatively to SUB on restart. Start a new ID for each
unrelated client session. No permanent user-wide policy is written.

## Exact control API

All calls require the inference key and `X-Gateway-Session`.

- `GET /v1/routing/session?profile=chat`: returns
  `{"session":"...","profile":"chat","policy":"SUB","version":0,...}`.
- `PUT /v1/routing/session?profile=chat` with JSON `{"policy":"PAID"}` explicitly
  sets permission. Allowed values are exactly FREE, SUB, PAID. Unknown fields and
  duplicate JSON keys fail. Response returns session/profile/policy/version.
- Equivalent profile-local paths: `/chat/v1/routing/session` and
  `/coding/v1/routing/session`. A conflicting query profile fails.
- Repeating the same PUT is idempotent and does not increment version. Changing
  permission increments version. These are permissions, not immediate dispatches.
- `/routing free|sub|paid` maps to explicit PUT. `/routing` and `/routing toggle`
  read current policy and cycle FREE → SUB → PAID → FREE client-side, then PUT.
  `/routing get` reads without changing it. The server has no retry-sensitive toggle.

Missing authentication = 401; invalid body/header/missing session = 400;
unknown profile = 404; invalid parent/capacity conflict = 409. APIs set no-store.
No API takes a raw credential, changes provider accounts, or performs inference.

## Telemetry

`GET /v1/routing/requests?profile=chat` (same key/session headers) returns
`{"session":"...","profile":"chat","data":[...]}`. Profile-local equivalents
exist. `request_id=...` optionally filters one request. Results cover this session
family only, are ordered by start time, retain up to 64 events per session and
return at most 128 family events. No prompts, responses or credential handles are
stored. Session/agent relationships supplied by clients are correlation labels.

Each event includes `request_id`, `prompt_id`, `session`, optional `parent_session`,
`parent_request_id`, `agent`, plus `profile`, `kind`, effective `policy`,
`policy_version`, actual `billing_class`, `requested_model`, `resolved_model`,
`provider`, `state`, `started_at`, optional `selected_at`, `completed_at`, `http_status`.
States include `awaiting_route`, `in_flight`, `attempt_failed`, `completed`, `failed`,
`canceled`. An HTTP200 stream can still be failed by the native lifecycle.

The final guard classifies the selected account/source using current proof.
UNKNOWN is explicit, not inferred as FREE from an allowed PAID request. Unverified
hosted-tool/premium charges also make telemetry UNKNOWN; FREE/SUB requests refuse
those features before dispatch. A billing class is route entitlement, not a provider
invoice or guarantee that a failed attempt incurred zero charge.

Responses expose `X-Gateway-Request-ID`, `X-Gateway-Session` when supplied,
`X-Gateway-Billing-Policy`, `X-Gateway-Billing-Class`, `X-Gateway-Policy-Version`,
plus existing requested/resolved model, provider, profile and similarity headers.
Native-owned HTTP compaction endpoints identify `compaction`; other clients must
label requests they can identify. Missing classification is never guessed as main.

## Claude/client integration assets

`clients/routing_client.py` is a stdlib helper: no retries, redirects, inference,
stored keys or prompt reading. It uses `NOTHING_API_KEY`,
`NOTHING_GATEWAY_SESSION`, `NOTHING_GATEWAY_PROFILE` (default chat).

```sh
python3 /installed/path/routing_client.py launch --profile chat --command claude
python3 /installed/path/routing_client.py get
python3 /installed/path/routing_client.py free
python3 /installed/path/routing_client.py toggle
python3 /installed/path/routing_client.py status
```

The launcher generates a logical session, sets Anthropic base `/chat`, defaults
model to the profile alias if unset, and propagates its session header/environment
to children. Copy `clients/claude-routing-command.md` to the desired Claude commands
scope as `routing.md`, configure `GATEWAY_ROUTING_HELPER` to the installed helper,
and install the status command through the client's existing settings/chezmoi.
Do not commit secrets or assume JSON expands environment variables.

The status helper shows the latest **foreground main** request's actual class:
yellow FREE, blue SUB, red PAID, with no permission prefix. Before verified route
selection, on unknown/errors, or without a correlated main request, it shows ` – `.
Between foreground requests it retains the last foreground result. Auxiliary and
child requests never overwrite it. A known foreground request ID can be selected
explicitly using `--request-id`.

A client transport/adapter must provide truthful per-request kind/correlation for
this display. A static Claude custom header cannot label all requests as main,
because subagents and compaction inherit that header too. The launcher intentionally
does not do that. Until the client integration supplies those labels, the display
stays `–`; do not claim that actual-class foreground display is verified merely
because a session header or fake request works. Actual Claude/Rakazo installation
and interactive acceptance belong to the client-configuring agent.

Chat Completions, Messages, Responses HTTP streaming and explicit-model Responses
compact use the native coordinator. Native token counting on the normal endpoint
is billing fenced and model-bound, but provider support is not fabricated. Profile
WebSockets, realtime, media and profile token-count routes are not added. Explicit
session headers on normal Responses WebSockets are rejected; use HTTP so policy
changes can apply to each subsequent request.
