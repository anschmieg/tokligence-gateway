# Adversarial review: deployed canonical routing

Reviewed native .11, source516db04 and release record8454bd2. Review-only:
no production mutation, no provider inference, no credential/quota changes.
A read-only production config check found no current native manual
source/alias collisions; FreeHub OpenRouter is blocked and its paid-model option
is false. These facts limit current exposure, but are not enforcement guarantees.

Verdict: **changes required**. The earlier claim that `:free` never selects a
paid route is stronger than the implemented boundary. Eight invariant checks
failed across six findings below, using fake executors and local native code.
The successful isolated/live happy paths did not cover these cases.

## P1 — final execution can alias a free source to a paid/different source

`canonical_registration.go:135` stores a supposedly final upstream source.
`prepare_canonical_catalog.py:33` inserts it into `rewriteModelForAuth`, but the
native execution path subsequently applies API-key aliases/model pools again.
A valid native config with `free-source -> free-display` and
`paid-source -> free-source`, together with a zero-price catalog row for
`free-source`, produces a free selector whose native resolution is `paid-source`.

Reproduced both with the real config/catalog/registration pipeline
(`TestAdversarialReviewRegistrationToNativeAliasPaidDispatch`) and a fake
executor (`TestAdversarialReviewPinnedFreeSourceReAliasedToPaid`, observed
`actual dispatch=[paid-upstream]`). This also invalidates exact-model disclosure
and same-model-only paid fallback if the alias redirects to different weights.

Fix: carry an immutable per-attempt final source/cost binding into execution;
skip subsequent alias/pool interpretation or reject a final target that differs.
A registration-time signature alone is insufficient.

## P1 — missing canonical base makes :free fall through to raw execution

`canonical_policy.go:56` returns unhandled when the base is missing. Both public
wrappers then call the legacy execution path. A retained, unqualified raw
`removed-model:free` override marked non-free is executed after its canonical
base disappears. This can occur with preserved explicit routes during catalog
withdrawal; the suffix is not independently enforced at dispatch.

`TestAdversarialReviewFreeSuffixAfterBaseRemoval` observed one successful fake
non-free dispatch. Reserve unqualified policy suffixes even when no canonical
base remains; return an admission error rather than falling through. Explicit
provider overrides need a distinct, unambiguous bypass rule.

## P1 — FreeHub vendor names stand in for per-model price evidence

`canonical_registration.go:78` marks every OpenRouter/Kilo/Cline/Zai/LLM7
publication free. The actual FreeHub OpenRouter adapter supports
`openrouter_paid_models`; enabling it publishes paid entries that this new
registration path then advertises as `:free`.

`TestAdversarialReviewFreeHubPaidOpenRouterClassifiedFree` reproduced a free
selector for an explicitly paid OpenRouter model. Current production blocks
that FreeHub vendor, so this is configuration-dependent exposure, not evidence
of a current charged request. Carry verified per-model cost metadata; a provider
allowlist is not a model-level free guarantee.

## P1 — streaming model pools escape the physical-attempt budget

`prepare_canonical_catalog.py:73` truncates model pools in non-stream/count paths,
but omits the separate streaming path. Native `executeStreamWithModelPool` can
still try several upstream models inside one counted coordinator attempt.

`TestAdversarialReviewStreamingPoolPhysicalBudget` observed
`[pool-a pool-b]` after a503 with `gateway.canonical_dispatch=true`. This can
exceed the stated physical dispatch budget and bypass coordinator cost,
compatibility and disclosure checks. Enforce one final target at the shared
native dispatch boundary, including stream bootstrap/model-pool execution.

## P2 — fallback compatibility misses supported protocol shapes

`canonicalRequestRequirements` recognizes image/audio/video MIME types but
ignores Gemini `fileData` with `application/pdf`. It also never records requested
OpenAI output `modalities:[text,audio]`; compatibility only requires text output.

Both `TestAdversarialReviewGeminiDocumentFallback` and
`TestAdversarialReviewRequestedAudioOutput` admitted a text-only alternative.
This contradicts the documented opaque-document refusal and can route an
unsupported request to another model. Parse input and output requirements per
protocol, conservatively refusing shapes whose compatibility cannot be proven.

## P2 — real model-family prefixes are stripped as transport tags

`identity.go:36` strips any leading `<owner>-`, even from an already unwrapped
model ID. Reproduced:

- owner Mistral, `mistral-small-3.2` → `small-3.2`
- owner deepseek, `deepseek-v4` → `v4`
- owner qwen, `qwen-3.7` → `3.7`

`TestAdversarialReviewFamilyPrefixNotTransport` failed all three assertions.
This corrupts canonical IDs/family fallback classification, and can merge bare
names incorrectly. Remove transport tags only with provenance that a wrapper
was added, not by matching a model-family prefix against an owner label.

## Evidence and limits

Regression sources are archived as `.go.txt` in
`canonical-routing-adversarial-20261103/`; they were copied into the corresponding
packages in `/tmp/cliproxy-canonical-policy-cooldown-final` and run against the
prepared .11 source. Initial failing output is archived there as well. The later
full-pipeline alias test additionally failed with:

```
real config/catalog/registration admitted source free-source;
native resolution changes it to "paid-source"
```

These tests deliberately assert the promised safe behavior and currently fail;
they are counterexamples, not new passing acceptance tests. One exploratory
fallback-liveness test only logged a bounded candidate selection and is not
counted as a finding. No live paid inference or exploitation was attempted.
Existing OpenCode holds and all completed live journals remain untouched.

## Resolution

All six findings were fixed and deployed in source5403559 (native `.12` +
FreeHub `.1.7`). Original counterexamples and results above are preserved as
review evidence. See `canonical-routing-hardening-20261103.md` for the fixes,
passing permanent regressions, isolated host verification and deployment scope.
