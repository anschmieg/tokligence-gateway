# Adversarial review: live-cached, confidence-weighted fallback draft

Reviewed commit: `2ec1410e3aefbba1c6f38bf096e8530809594bc1`.
Outcome: **changes required before deployment**. Six concrete counterexamples
reproduced against a new prepared native tree. No implementation, production,
account, credential, cooldown, schedule or live-provider changes were made.
All scores below are synthetic fixtures, not claims about real GLM/MiniMax scores.

## P1 — Requirement parser and native translator disagree on duplicate keys

Source: [request.go:18](../../staging/cli-proxy-api/catalog-fallback/policy/request.go#L18).
`encoding/json` uses the last duplicate member; the pinned native translator uses
`gjson`, which reads the first. A request containing a nonempty `tools` field
followed by `tools: []` yields `router_tools=false`, yet the actual native
OpenAI→Claude translator emits one tool. A supposedly hard capability gate can
therefore approve a request the downstream translator interprets differently.

Proof: `TestAdversarialLogicDuplicateProtocolControlsRefused`, including the real
native translator (no upstream transport). Reject duplicate protocol keys before
routing, or use one shared unambiguous parsed representation through translation.
Checking capability hashes does not repair a mismatched request interpretation.

## P1 — Paid-only models do not reach their planned free alternatives

Source: existing coordinator's `canonicalCanContinue`,
[canonical_policy.go:309](../../staging/cli-proxy-api/patches/canonical_catalog/canonical_policy.go#L309),
retained by the new draft preparation. The planner constructs both original
`:free` and alternate `:free` stages. With zero direct free routes but an available
compatible alternate, native resolution returns local400 `model_not_found` for
the original stage. The continuation predicate refuses400, so the alternate is
never tried. The real native manager/fake-executor fixture records zero calls.

Proof: `TestAdversarialLogicPaidOnlyModelCanHaveFreeAlternative`. Skip an empty
original stage, or distinguish local absent-route results from genuine invalid
requests. Do not broadly retry upstream400 errors. This also explains why merely
advertising a constructed `free_only_id` cannot establish usable free inference.

## P2 — Average benchmark gains can conceal a catastrophic relevant regression

Source: [evidence.go:116](../../staging/cli-proxy-api/catalog-fallback/policy/evidence.go#L116)
and the final mean-based risk score at line132. Two same-category benchmark
scores are80/20 for the requested model. Candidate A scores0/100; candidate B
scores79/19. The ranker prefers A: its80-point regression is canceled by an80-point
improvement, giving risk0.10 instead of B's0.106. Worst loss0.80 is calculated but
not used by the normal native policy; the optional pure-library loss bound does
not supply a default task-adequacy safeguard.

Proof: `TestAdversarialLogicCatastrophicTaskRegressionNotCompensated`. Establish
minimum adequacy for request-relevant dimensions before aggregate utility; use
non-compensatory/tail-risk treatment for gross deficits. Benchmarks are not
interchangeable units of user utility simply because both are percentages.
Confidence weighting alone cannot fix a wrongly defined utility function.

## P2 — A new unmapped route erases trusted evidence and can promote a worse model

Source: [policy.go:191](../../staging/cli-proxy-api/catalog-fallback/policy/policy.go#L191).
One unresolved provider/source sets `allKnown=false` for the whole canonical group.
In the repro, the known-worse model initially has risk0.55 and ranks behind a
candidate at0.265. Adding one healthy route with the same canonical ID but an
unresolved catalog mapping erases its evidence, changes risk to the unknown
prior0.25, and promotes it to first place. In strict mode the reverse problem
occurs: one unmapped route removes the otherwise evaluated model entirely.

Proof: `TestAdversarialLogicNewUnmappedRouteCannotEraseKnownModelEvidence`. Keep
verified model evidence stable, and partition/limit eligible route sets by proven
identity. An unresolved route must neither borrow another route's benchmarks nor
erase established negative evidence for that model. Conservative identity handling
and the unknown prior currently interact to produce an optimism loophole.

## P2 — Benchmark aliases inflate independent support and bypass strict evidence

Source: [evidence.go:44](../../staging/cli-proxy-api/catalog-fallback/policy/evidence.go#L44).
Punctuation is normalized, but known semantic aliases are not. `BFCL` and
`Berkeley Function Calling Leaderboard` are both recognized by the task taxonomy,
yet count as different independent benchmarks. Duplicating the same result under
both names raises confidence from0.45 to0.60, reduces risk from0.1465 to0.112, and
changes the band from `partial` to `comparable`. The purported two-benchmark
strictness requirement is satisfied by one benchmark reported twice.

Proof: `TestAdversarialLogicBenchmarkAliasesCannotInflateSupport`. Assign canonical
benchmark identities before conflict handling, coverage and independent-support
counting. Preserve reported names/provenance separately. More generally, confidence
weights remain policy heuristics, not calibrated probabilities of task success.

## P2 — Gemini forced tool-choice requirements are omitted

Source: [request.go:158](../../staging/cli-proxy-api/catalog-fallback/policy/request.go#L158)
and surrounding Gemini request extraction. A valid `toolConfig.functionCallingConfig`
with mode`ANY` and allowed function names is not mapped into `ToolChoice`.
The repro has `Tools=true`, `ToolChoice=false`, and admits a candidate whose
metadata explicitly lacks tool-choice support. The request's hard behavioral
constraint is therefore not represented in the capability check.

Proof: `TestAdversarialLogicGeminiForcedToolChoiceRequiresCapability`. Normalize
native forced-call modes/restrictions into typed requirements and refuse routes
that cannot preserve them. Generic tool support is not forced-tool support.

## Controls and scope

The following controls passed with `-race`: source-bound disk bootstrap/restart,
200/304 freshness, outage age preservation, malformed-update/redirect/source-mismatch
rejection, native Git data-only parsing/provenance/alias confinement, known benchmark
settings-conflict rejection, external-price isolation, opaque-state refusal,
terminal authentication/uncertain-error behavior, and final capability revocation.
No new cache freshness or paid-route escape was demonstrated. This is not a proof
that every cache/dispatch scenario is safe. A separate suspected stale-plan source
change did not reach the fake executor; it is not reported as a confirmed finding.

Commands and fake-only repro sources/results are archived in
[catalog-fallback-adversarial-20261103](catalog-fallback-adversarial-20261103/README.md).
Control filter:

```sh
go test -race ./internal/catalogfallback ./sdk/api/handlers ./sdk/cliproxy/auth \
 -run 'TestDraftLiveCache|TestDraftNativeGit|TestDraftNativeLiveGit|TestDraftKnownSettings|TestDraftOpaqueState|TestDraftExternalPrice|TestCanonicalAuthenticationAndUncertainErrorsNeverFallback|TestReviewSimilarityCapability' \
 -v -count=1
```

## Catalog contract and newly clarified policy

`free_only_id` is mechanically `id + ":free"` in the current metadata generator,
so it is redundant for naming. Keep paid-only canonical records in the full
`/v1/models` catalog. A client may derive the suffix rather than receiving an
available free-only row for every constructed string. `has_free_routes` currently
counts registered direct free selectors; it is neither complete fallback-graph
availability nor a guarantee of current quota. Fix the paid-only fallback defect
before claiming that `:free` can rescue every otherwise paid-only canonical model.
Deprecate redundant metadata in a deliberate consumer-compatible contract change;
no API field was removed during this review.

Recommended meaning of `:free`: no incremental metered charge, including verified
subscription allowances. No paid overage, paid-credit draw, automatic topup or
paid fallback; native quota/cooldown rules still apply. The present registration
code accepts FreeHub `free`/`included` cost tiers, but classifies several native
providers using `AuthKind() != api_key` alone (canonical_registration.go:90).
Authentication kind alone does not establish entitlement/overage behavior. That
is an additional policy-evidence gap to address, **not a demonstrated live billing
incident**. Do not promise a no-charge guarantee solely because a credential uses
OAuth. Unknown billing eligibility should remain excluded from strict free-only.

The user's proposed gateway-owned `coding` profile is appropriate: retain the
full canonical catalog; publish a small curated view/selection metadata using the
same capabilities, identities, eligibility and evidence policy as routing.
Clients choose a named profile; chezmoi selects/syncs it rather than copying ranking
rules. Explicit IDs/overrides stay usable. Profile selection is a presentation/task
preference, not route authorization or permission to incur charges. Cost policy
remains explicit through canonical vs`:free` requests. Dynamic curation should
include reasons/policy version/freshness and must not confuse quota exhaustion
with permanent model unsuitability. No profile endpoint or chezmoi changes were
implemented in this review.
