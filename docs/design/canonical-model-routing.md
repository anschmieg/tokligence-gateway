# Canonical model IDs and cost policy

All registered credential-backed models receive a deterministic canonical ID.
`/v1/models` lists those IDs once; native Gemini/Claude/Codex discovery uses the
same filtered registry. Original IDs remain callable, and each entry's
`overrides` lists provider-qualified IDs that bypass canonical policy.
No `paygo/` namespace is introduced.

- Plain ID, e.g. `glm-5.3-flash`: all eligible free/included providers are peers under native credential
  selection, then paid routes for **that same model**, with paid OpenRouter last.
- `glm-5.3-flash:free`: never selects a paid route. After original-model free
  routes fail or are unavailable, considers up to three compatible free models.
  Family presets rank GLM 4.7 Flash, GLM 4.5 Flash, then Beam; other families have
  conservative presets and same-family candidates. Removed/unavailable models
  disappear from consideration automatically.
- Explicit override, e.g. `orca/z-ai/glm-5.3-flash-free`: exact source selection;
  no cross-provider or cross-model coordinator.

The coordinator uses the native auth manager/selector and its cooldowns.
Canonical aliases resolve to a stable source identity: native compatible upstream
IDs or plugin transport IDs, so display aliases cannot create fresh cooldown keys. Default
budget is eight selected credential/model attempts, bounded to twelve even if
configured higher. Every physical pair can be attempted only once per request;
SDK retries, streaming bootstrap retries, request-driven 401 refresh/replay,
Antigravity paid-credit escalation, and multi-source alias replay are disabled
for policy attempts. No background inference probes are added.

Only explicit 404, 429 or 503 failures can advance after selection. Validation,
authentication, ambiguous gateway failures and timeouts stop. Once a streaming
chunk is emitted, errors stay on that stream; another completion is never
spliced into it. These are deliberate request-level fallbacks, not a guarantee
that every provider/model is healthy or that failed upstream requests cost zero.

Cross-model fallback is chat/text only, requires declared compatible modalities,
context/output limits and requested tool/JSON/reasoning features. Unknown
capabilities fail closed; opaque media/document input is not substituted.
Similarity is a curated family heuristic, not a claim that different weights
produce identical answers. Configure `models.canonical-routing.free-fallbacks`
to override family lists. Preset members rank first; other same-family models
rank afterward, with reverse lexicographic ID ordering for ties (not numeric
version or measured quality). The current registry and request requirements
are checked afresh per request; this is not a semantic similarity score. Provider-specific variants, search, reasoning modes,
quantizations and dated versions retain distinct identities unless an exact
reviewed equivalence exists.

The actual alternate-model chain is assembled per request:

1. Classify the requested canonical ID by its name prefix (GLM, Gemini, Claude,
   GPT/GPT-OSS, Nemotron, Llama, Qwen, Mistral, MiniMax, DeepSeek, Kimi or Beam;
   otherwise the shared default bucket).
2. Read the configured family list, or use the built-in preset. GLM uses
   `glm-4.7-flash`, `glm-4.5-flash`, `beam-free`. Gemini uses
   `gemini-3.8-flash`, `gemini-3.5-flash-lite`, `gemini-3.1-flash-lite`,
   `nemotron-3.5-lightning`, `beam-free`. Other/default families use
   `nemotron-3.5-lightning`, `beam-free`, `glm-4.7-flash`.
3. Intersect with current canonical registrations having at least one
   capability-compatible free route. Exclude the requested model and search,
   `auto/` and `router/` IDs. Non-preset models enter only if their family bucket
   matches. Unknown families sharing the default bucket is a coarse heuristic.
4. Sort preset members by list position, then non-preset family members by
   reverse lexicographic ID. Keep up to three alternatives by default (hard
   maximum six). This does not estimate semantic distance or model quality.
5. Exhaust selectable original-model free routes before alternatives, subject
   to the shared attempt budget and terminal-error rules above. Recheck each
   alternative route's capabilities and final cost/source binding. A 429 excludes
   that credential from remaining free alternatives in the same request.

Cost admission is conservative. Native compatible routes require a fresh,
zero-price catalog admission; stale/removed/repriced sources lose free eligibility.
FreeHub models carry explicit source/cost evidence; a per-credential ledger
rechecks it at dispatch. Provider names and paid-visibility toggles never grant
free admission. Unproven account-specific entitlements are not inferred from a token. The operator's shared `gemini-free`
group is explicitly marked `free-tier: true`; do not put billed projects in it.
OAuth subscription/included-allowance lanes do not gain paid-credit escalation.
Unknown pricing remains eligible only for plain/explicit requests, never `:free`.
This is route admission, not a provider-side spending cap.

Successful responses disclose `X-Gateway-Requested-Model`,
`X-Gateway-Resolved-Model`, `X-Gateway-Provider`, `X-Gateway-Cost-Policy`.
Structured logs record the same resolution and attempt count. The upstream
response model is retained; canonical discovery advertises `free_only_id`,
`has_free_routes`, `routing_policy` and available `overrides`.

Implementation: pinned native extension under
`staging/cli-proxy-api/patches/canonical_catalog`, prepared on reviewed native .9
by `prepare_canonical_catalog.py`. It is not stock CLIProxyAPI configuration:
registration, discovery filtering and bounded coordination are custom; native
translation, auth ownership, execution and cooldown handling remain in use.

Adversarial hardening on Nov3: canonical sources bypass subsequent alias/pool
resolution, a shared one-use executor permit prevents hidden replay, and cost
bindings are checked at dispatch. Unknown canonical :free names fail closed;
only registered overrides with positive provider provenance bypass policy.
See [the fix report](canonical-routing-hardening-20261103.md) and its isolated
host evidence. The earlier review remains an immutable record of the failures.
