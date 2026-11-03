# Nothing gateway: client setup handoff

Configure the client to use the existing gateway and its **coding profile**.
Keep that client's preferred model; different clients can prefer different models.
Merge changes into its current configuration (or chezmoi source), preserving
unrelated settings. This document contains no credentials.

## URLs and authentication

| Client protocol | Base URL | Resulting inference path |
| --- | --- | --- |
| OpenAI Chat / Responses | `https://code.nothing.pink/coding/v1` | `/coding/v1/chat/completions` or `/coding/v1/responses` |
| Anthropic / Claude Code | `https://code.nothing.pink/coding` | `/coding/v1/messages` |

Use the existing **gateway inference API key**, for example from the user's
`NOTHING_API_KEY` secret. Send `Authorization: Bearer <key>`. Do not use a provider
key, Management Key, or Cloudflare browser cookie. Cloudflare login is for admin.
Check how the installed client appends paths; avoid `/v1/v1`.

For Claude Code CLI, a session-scoped example is:

```sh
: "${NOTHING_API_KEY:?Load the existing gateway secret first}"
export ANTHROPIC_BASE_URL="https://code.nothing.pink/coding"
export ANTHROPIC_AUTH_TOKEN="$NOTHING_API_KEY"
export ANTHROPIC_MODEL="nemotron-3.5-lightning"
claude
```

Replace the example model with the user's preferred **canonical ID**. Resolve
conflicting client credentials/provider settings deliberately; do not delete saved
logins. For persistence, configure the client's existing secret mechanism and
settings scope. Do not commit keys or assume JSON strings expand `$ENV_VARS`.
See the [official Claude Code gateway guide](https://code.claude.com/docs/en/llm-gateway-connect)
for settings-file scopes and `/status` verification.

## What routing does

1. The requested model is a strong preference. Eligible providers/credentials for
   that model are tried first, using native priority, weighting and cooldowns.
2. If continuation is permitted, alternatives are ranked by task-specific
   similarity to the **original requested model**, not chosen round-robin.
3. The coding profile allows **zero additional metered charge**: verified free
   quotas and verified included subscription allowances. OAuth alone is not proof
   of this entitlement. Unknown/paid routes are excluded; no `:free` suffix is needed.

Capabilities, context requirements, account state and cost are checked before
dispatch. Missing comparison evidence stays uncertain. Signed/encrypted or
provider-owned conversation state can prevent model switching. Terminal or
uncertain failures can stop fallback; a committed stream never switches models.

## Discovery, overrides and testing

- `GET /coding/v1/models`: curated coding picker. Its size/content can change as
  models, availability and evidence change; do not hardcode today's list. A model
  absent from this small picker can still be an explicit eligible preference.
- `GET /v1/models`: full canonical catalog and available override metadata.
- For strict same-model behavior, use the normal base `/v1` (Anthropic base `/`)
  and a canonical ID. Its normal policy can use PAYGO. For exact provider control,
  use an advertised provider-qualified override there; it is not a coding hint.

First verify discovery with the existing key, then inspect the client's effective
base URL/model. For a deliberate end-to-end test, check the response headers
`X-Gateway-Requested-Model`, `X-Gateway-Resolved-Model`, `X-Gateway-Profile`,
`X-Gateway-Cost-Policy` and `X-Gateway-Similarity-Anchor`. Report actual failures;
do not switch silently to a direct/paid endpoint or run retry/probe loops.

Chat, Messages and Responses streaming are implemented. Profile paths currently
do **not** expose token counting, WebSockets, compact-state or media endpoints;
client features requiring those need separate compatibility work. Isolated host
tests passed, but this is not a claim that every complete client workflow passed.
Automated public checks from the implementation host hit Cloudflare error 1010;
report that separately from gateway authentication or model failures.
