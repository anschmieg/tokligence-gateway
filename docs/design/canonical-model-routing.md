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
  A context-aware similarity ranker considers all compatible free canonical
  models, prioritizing family continuity for ongoing portable agent history.
  Removed/repriced/suspended routes lose eligibility automatically.
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
Similarity is an explainable metadata/name feature score, not a quality benchmark,
weight-equivalence claim, or external LLM classifier. No hardcoded model presets
remain. Provider-specific variants, search, reasoning modes, quantizations and
dated versions retain distinct identities unless reviewed equivalence exists.

The alternate-model chain is assembled per request:

1. Detect requirements from the original request and conversation history,
   including historical tool calls/results and unsigned reasoning. Ordinary
   portable history stays intact; it is never stripped to make a candidate fit.
2. Recognized signed thinking, encrypted/redacted reasoning, Responses item or
   conversation references, and server-managed built-in tool history disable
   cross-model substitution. A shared family name is not evidence that these
   states are portable. Original-model provider selection is unchanged; even
   that does not prove a provider-bound signature can move between providers.
3. Enumerate current canonical registrations across **all families**. Require a
   free route with declared compatible capabilities and sufficient context/output
   limits. Exclude known non-chat endpoints and recorded route suspensions/quota
   holds. Native selection and final dispatch guards remain authoritative.
4. Score family and numeric generation proximity, coding/math specialization,
   fast/large naming profile, known parameter-count scale, context/output scale,
   supported-parameter overlap, modalities and reasoning profile. Unknown data
   gets no invented score; mandatory capability unknowns remain excluded. Use
   the least similar eligible route for a model, since native selection may
   choose any eligible credential. Duplicate credentials never increase a score.
5. For ongoing tool loops, unsigned reasoning history or multiple assistant
   turns, compatible same-family candidates precede other families. For portable
   new tasks, stronger specialization/capability fit can outrank family match.
   A bounded continuity shortlist reserves its last slot for a cross-family
   rescue if otherwise every slot would be same-family (when the limit is >1).
6. Default maximum is three alternate models (hard maximum six), within the
   existing shared request-attempt budget. Equal scores use ascending ID solely
   for deterministic ties. Numeric version ordering is never lexicographic.

`models.canonical-routing.free-fallbacks` now provides optional ranked preference
**bonuses** by family (or `default`), not a closed list; it cannot admit paid or
incompatible candidates, override opaque-state refusal, or outrank the agent
continuity class. Thus new eligible models can enter without editing lists.
Debug logs expose candidate IDs, total/component scores and continuity flags;
no prompt content, tool arguments, credentials or history payload is logged.
See [the scoring and verification contract](canonical-similarity-20261103.md).

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
