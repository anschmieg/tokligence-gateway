# Nothing gateway: agent setup handoff

Use the existing gateway inference key from `NOTHING_API_KEY` or the user's secret
mechanism. Merge settings/chezmoi changes without replacing unrelated configuration.
Never commit keys. Cloudflare login and the Management Key are for administration.

## Pick a task profile

- Default conversational agent: **chat**.
- Development agents: **coding**.
- Meeting/transcript copilots: **assistant**, base `https://code.nothing.pink/assistant/v1`
  or normal `/v1` with model `assistant`. Initial preference: `glm-5.3-flash`;
  SUB default. Anthropic base: `https://code.nothing.pink/assistant`.
  This is a general-task profile with similarity fallback, not a measured
  low-latency ranking or a meeting-specific system prompt. Keep the app's
  transcript instructions and concise-output limits; prefer streaming. Audio
  and tool capabilities must be supported by each selected route.
- Easiest OpenAI-compatible setup, including Rakazo: base URL
  `https://code.nothing.pink/v1`, model **`chat`** or **`coding`**. These virtual
  aliases explicitly enable profile routing. Chat prefers
  `nemotron-3-ultra-550b-a55b`; coding prefers `glm-5.3-flash`. The gateway
  config can change these preferences.
- To keep a client's own model preference, use base
  `https://code.nothing.pink/chat/v1` or `/coding/v1` and its preferred canonical ID.
- For Anthropic/Claude Code, omit the final `/v1` from the base; the resulting
  request must be `/chat/v1/messages` or `/coding/v1/messages`.

For example, with the existing key loaded:

```sh
export ANTHROPIC_BASE_URL="https://code.nothing.pink/chat"
export ANTHROPIC_AUTH_TOKEN="$NOTHING_API_KEY"
export ANTHROPIC_MODEL="chat"
```

Avoid conflicting saved provider settings and duplicated `/v1/v1`. Use the
[official Claude gateway guide](https://code.claude.com/docs/en/llm-gateway-connect)
for settings scopes and `/status`; JSON settings do not expand shell variables.

## Routing and spending

Profile requests try the preferred model first, then similarity-ranked alternatives
anchored to that original preference. Credentials use native selection within each
model. The normal endpoint with an ordinary model ID stays model-bound; advertised
provider-qualified overrides allow exact provider control.

Default billing permission is **SUB**: verified FREE plus verified included
subscription allowances, no PAYGO. Explicit PAID permits PAYGO, after FREE/SUB for
each model. `:free` restricts one request to FREE only, excluding subscriptions.
On ordinary model IDs it cannot change the model; `chat:free`/`coding:free`/`assistant:free` remain
explicit profile aliases. Unknown entitlement never qualifies for FREE/SUB.

## Sessions, commands and status

Use a new opaque `X-Gateway-Session` for each unrelated session. Propagate it to
subagents/compaction; distinct child IDs can link with `X-Gateway-Parent-Session`.
Policies are scoped by authenticated key identity, session family and task profile;
new unrelated sessions default to SUB. Each request captures permission once.

The exact control/telemetry API and installable helper/Claude command assets are in
[SESSION-BILLING.md](../staging/cli-proxy-api/catalog-fallback/SESSION-BILLING.md).
`/routing free|sub|paid` sets policy; empty/toggle cycles FREE → SUB → PAID → FREE.
The API uses explicit idempotent PUT, never a server-side toggle.

Status shows actual serving class (FREE yellow / SUB blue / PAID red), not allowed
policy. Truthful per-request `main`, `subagent`, `compaction`, `auxiliary` labels are
needed; unlabelled requests stay unspecified. Before selection or when unknown,
show ` – `. Never label every Claude request as main through a static header.

## Discovery and acceptance

`/v1/models` contains the full catalog plus explicit virtual aliases. Profile
`/models` gives a dynamic curated view, independent of billing permission; do not
hardcode its list. Other eligible explicit preferences remain usable. Check actual
requested/resolved model, billing class/policy and request-ID response headers.
No committed stream changes model; opaque/compact continuations require an explicit
model. Check protocol/client limits in the contract before enabling extra features.

First check authenticated discovery, then run a deliberate client test. Do not
silently enable direct/paid fallbacks or retry loops. Backend isolated tests do not
prove complete Claude/Rakazo integration. Public automated requests from the build
host encounter Cloudflare1010; distinguish that from native auth/model failures.
