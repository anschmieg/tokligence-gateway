# Adversarial review: context-aware fallback similarity

Reviewed native .14 implementation22ba749, documentation/head110a8aa.
**Changes required. Six offline counterexamples fail their intended invariants.**
The deployed binary, configuration, accounts, plugins, cooldowns and quarantine
were not changed. No provider HTTP/inference was performed.

Review artifacts are in [canonical-similarity-adversarial-20261103/](canonical-similarity-adversarial-20261103/).
These include the exact fake-only repro sources (`.go.txt`, deliberately outside
normal test discovery), output, passing controls and source hashes. Failures are
intentional assertions exposing current behavior, not tests claimed to pass.

## P1 — Native-supported nested tool signature escapes the opaque-state guard

Location: [canonical_history.go:87](../../staging/cli-proxy-api/patches/canonical_catalog/canonical_history.go#L87).

History traversal visits `tool_calls` and `extra_content` but not a tool call's
`function` object. A signature at
`messages[].tool_calls[].function.extra_content.google.thought_signature`
is therefore missed. This is a recognized native field: the pinned Gemini
translator's `openAIToolCallGeminiThoughtSignature` explicitly accepts
`function.extra_content.google.thought_signature`.

The real canonical handler + auth manager + fake executor reproduced
`OpaqueState=false`, both original routes returning503, then a successful
**different-model dispatch** to GLM4.7. Thus the newly advertised opaque-state
refusal is bypassable with a supported input shape. No real signature was used.

Fix: cover native-supported protocol locations with a shared/tested state
extractor, including function extras, without recursing into arbitrary tool
arguments as protocol state. Regression must verify no alternate executor call.

## P1 — Final dispatch binding does not fence capability revocation

Locations: [canonical_policy_execution.go:64](../../staging/cli-proxy-api/patches/canonical_catalog/canonical_policy_execution.go#L64),
[routing_types.go:46](../../staging/cli-proxy-api/patches/canonical_catalog/routing_types.go#L46).

The immutable binding includes source/cost/owner but omits capabilities and
registration epoch. After the handler checks a route and captures that binding,
a metadata refresh can revoke tools and lower context/output limits without
changing the binding. The final guard still admits the stale capability decision.

A deterministic handoff simulation captured the same native dispatch binding,
re-registered the route with no tools and context/output limits1, then called the
real manager with tools, longer input and max_tokens20. The fake executor was
physically invoked once, with no rejection. This proves the final boundary gap;
it is not a claim that such a race was observed in production.

Fix: bind capability requirements and an epoch/fingerprint, and validate the
currently registered target at the final boundary. Existing source/cost binding
and the single-use permit must remain intact.

## P2 — Reasoning-mode compatibility checks presence, not the requested value

Location: [canonical_policy.go:213](../../staging/cli-proxy-api/patches/canonical_catalog/canonical_policy.go#L213).

`reasoning_effort: high` becomes one boolean. Any non-nil `Thinking` declaration
passes, including `Levels:[low]`. The repro shows `canonicalCompatible=true`
while the pinned native `thinking.ValidateConfig` rejects that exact explicit
mode: `level high not supported, valid levels: low`.

The coordinator can select a fallback that is known to reject the request before
HTTP; a terminal400 can then prevent trying a compatible model. This is not proof
that every declared reasoning endpoint fails, or that a provider call occurred.

Fix: carry and validate actual reasoning level/budget/disable requirements using
the native validation semantics before ranking and again at dispatch.

## P2 — Expired registry quota markers can keep recovered fallback routes excluded

Location: [canonical_similarity.go:309](../../staging/cli-proxy-api/patches/canonical_catalog/canonical_similarity.go#L309).

The ranker uses `IsModelQuotaExceededForClient`, which tests map membership, not
expiry. Native model availability considers the same quota expired after its
five-minute registry window. A scratch test injects an old fake timestamp:
native availability is true while the ranker's predicate still says held.

`CleanupExpiredQuotas` exists but no production caller was found in the pinned
source. A direct request/success or another explicit state update can clear a
marker, but a model used only as a fallback may stay excluded after recovery.
This finding concerns the native short-lived registry marker only; it does NOT
authorize clearing durable OpenCode investigation holds or quarantine.

Fix: use an authoritative read-only eligibility predicate that respects expiry,
credential state and durable holds. Do not silently clear records or probe.

## P2 — User-defined tool-schema fields are mistaken for media attachments

Location: [canonical_policy.go:124](../../staging/cli-proxy-api/patches/canonical_catalog/canonical_policy.go#L124).

The shared request scanner recursively visits all JSON, including tool argument
schemas. A legal text-only tool with a string property named `fileData` causes
`Modalities[file]=true`; all cross-model substitutions are then rejected. The
repro uses no files/media, but a fully capable text/tools model is incompatible.
This is a pre-existing request-parser behavior reused by the new ranker.

Fix: distinguish protocol content/generation settings from schemas, user tool
arguments and tool-result data. Preserve conservative actual-media handling.

## P2 — Unverified publisher namespaces gain an absolute family-continuity class

Location: [canonical_similarity.go:32](../../staging/cli-proxy-api/patches/canonical_catalog/canonical_similarity.go#L32).

Similarity discards every publisher namespace, even where canonical identity
correctly retained it because equivalence was unproven. In a synthetic example,
`publisher-a/agent-5-coder` and `publisher-b/agent-5-coder` receive the same family
and `Continuity=true`. That class outranks every different-family candidate in
an agent loop, regardless of score. No evidence links the two publishers' models.

This is a ranking-confidence counterexample, not demonstrated hidden-state
corruption or evidence that a current production publisher pair is unrelated.
A matching leaf name can be a useful soft feature; it should not become an
unqualified claim of family continuity across unknown publishers.

Fix: retain namespace/lineage confidence for unknown families. Award the strong
continuity class only for established lineage, using name resemblance as a soft
similarity signal otherwise. Keep declared capability checks mandatory.

## Controls and boundaries

Existing exact source/cost repricing rejection, one-use physical-dispatch permit,
stream-pool replay prevention, free-only fallback and no-post-output-fallback
controls passed. No new paid-route escape was demonstrated in this review.
That is limited evidence from these controls, not proof that all routing paths,
all provider metadata or all possible history formats are correct.

Recommended order: opaque protocol traversal and final capability fencing first;
then exact reasoning validation and native availability alignment; then schema
scope and family confidence. Do not change production based on this review alone
or replay any earlier deployment/live journal.
