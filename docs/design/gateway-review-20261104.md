# Integrated gateway review — November 4, 2026

Reviewed source `5e1b6c6`, deployed native .17, canonical model/profile/billing adapters,
policy and metadata-cache code, client helper and onboarding contracts, deployment
and isolated-host evidence. Read-only production configuration inspection confirmed
chat/coding/assistant and **zero** no-charge allowance receipts. No production
mutation, provider inference, credential output or fresh broad upstream test run.
This is an integrated review of the current implementation, not a new live audit
of every historical provider or an exhaustive Cloudflare/OAuth penetration test.

## Findings

### P1 — Explicit PAID profile features are still unconditionally refused

`host/catalog_fallback_handlers_profile.go:147` permits unverified metered features
when the captured session permission is PAID. But line226 passes those unchanged
requirements into `policy/policy.go:138`, which unconditionally refuses them.
Line228 converts every ranking refusal into the incorrect diagnosis “profile model
identity is ambiguous.” This blocks even the eligible original model before dispatch.

Reproduced in the exact .17 reconstructed source: PAID + coding profile + web_search
returns409, zero executor calls. The existing ordinary-endpoint PAID feature test
covers a different path and misses this regression. The fake request establishes
planner behavior only, not whether a real provider implements web_search.

Robust correction: separate permission to dispatch the original model from permission
to transfer feature semantics across models. Preserve final cost/feature checks;
permit explicitly PAID exact-model execution when appropriate, restrict unsupported
cross-model features deliberately, and return a typed, accurate refusal reason.

### P1 completion gap — SUB has no configured subscription entitlements

Production read-only inspection found zero `no-charge-allowances`. In
`host/catalog_fallback_auth_billing.go:24`, a receipt is the implemented way to prove
an included subscription; absent free-source proof or a valid receipt, a route
remains PAID/UNKNOWN and default SUB excludes it. OAuth sign-in alone correctly
proves no entitlement.

Therefore “SUB supports subscriptions” describes the mechanism, not completed
production availability for the connected Codex/Antigravity accounts. Earlier
provider live passes predate this billing rollout and do not establish current
SUB acceptance. This is not evidence of unintended billing, and receipts must not
be fabricated to restore an old green check.

Robust correction: establish actual account/source allowance and no-overage evidence,
configure expiring scoped receipts only for justified routes, then deliberately
verify representative SUB dispatch. Disclose unsupported/unverified subscriptions.

### P2 — Unknown-evidence alternatives are removed before confidence ranking

`host/catalog_fallback_handlers_profile.go:61–63` admits a nonpreferred candidate
only when it has exact-source task evidence. The later `Rank(...AllowUnknown:true)`
cannot rank any alternative eliminated there. Thus missing benchmark coverage is
a hard execution exclusion in profiles, rather than merely uncertainty. This
particularly matters as providers/models are added and source mappings lag.

Robust correction: separate small picker curation from fallback admission. Use
current capabilities/economics for dispatch eligibility and the documented unknown-
evidence policy for ranking. Make any strict comparable-evidence requirement
explicit rather than silently coupling it to picker membership. Preserve exact
identity/no borrowed benchmark proof.

### P2 — Assistant/chat differentiation is primarily configuration

Assistant and chat both use task `general`; assistant has a different default and
picker cap. No meeting-specific quality signal, measured passive latency feed,
first-token objective, speaker-attribution score or transcript evaluation is wired
into production ranking. Model defaults are operator preferences, not tested
conversational/meeting superiority. General request requirements still fence tools,
context and opaque state. Media budgets are conservative; the profile does not
add transcription/realtime/audio routes.

Robust correction: retain the simple profile mechanism, add passive route timing
and a small representative transcript evaluation before claiming latency/quality
optimization. Avoid another model-ranking subsystem or hardcoded per-model chains.

### P2 — Foreground status-line integration remains incomplete

`clients/routing_client.py:33–36` propagates the session but intentionally does not
label all inherited traffic `main`. This is correct: static headers cannot distinguish
subagents/compaction. However, no client transport adapter supplying truthful
per-request labels is delivered here. The normal launcher alone leaves foreground
status `–`; backend fake main events do not demonstrate interactive Claude/Rakazo
acceptance.

Robust correction: implement/verify classification at a client-supported per-request
boundary or explicitly keep the display unavailable. Do not replace it with
permission labels or guess foreground from request timing.

### P2 — Profile discovery does not expose effective session eligibility

`ProfileModels` deliberately curates with BillingPaid (`...handlers_profile.go:84`)
independently of permission, as agreed. Production assistant discovery includes
GPT alternatives while zero allowance receipts exist. The API exposes SUB as the
default, but no per-row effective-policy admission/reason. A picker may therefore
show an unavailable-under-SUB preference which actually serves another model.
This is not a PAYGO escape: dispatch still rejects nonadmitted economics.

Robust correction: keep task curation independent, add separately labelled current
billing eligibility/unknown reason (or a session-aware availability view), and make
requested versus served identity visible in clients. Do not silently hide paid
models from the full catalog or conflate `has_free_routes` with instantaneous quota.

## Other important limits

- Session state is process-local/24h idle. Restart resets PAID to SUB but also FREE
  to SUB, which is broader than FREE. This is documented default behavior, not
  durable session-only preference persistence. Calling it universally conservative
  is inaccurate. A persistent strict-FREE client should also send `:free`.
- Legacy config `cost-policy: free-only` means no additional charge and can admit
  SUB, unlike the request suffix `:free`, which strictly excludes SUB. A fake case
  reproduced this documented compatibility behavior; it is naming ambiguity, not
  a newly established billing-policy breach. Prefer explicit permission enums.
- The native adapter is custom backend code, not stock CLIProxyAPI configuration
  or a single loadable plugin. Rebuild/source pins and final dispatch guards reduce
  deployment risk but do not eliminate upstream maintenance.
- Existing real provider results are representative paths at recorded times;
  neither the 12-mock-request fixture nor cached benchmarks establish universal
  provider availability, subscription coverage or subjective quality.

## Preserved strengths

One native credential/dispatch owner; final account/source-bound economic fences;
ordinary IDs binding and profile IDs explicitly flexible; original-reference
similarity; no model switch after committed output; required capabilities and opaque
state checks; snapshot-captured permission with final entitlement revocation checks;
source-bound validated cached public metadata; key-authenticated session-family
telemetry without prompt/token storage; no browser Management Key; isolated exact-
artifact fixtures; scoped If-Match configuration and single-owner rollout journals.
These are architectural/code and recorded-test observations, not a new proof that
all security paths are defect-free.

## Verification and next work

Fake-only counterexample source: `gateway-review-20261104/repro_test.go`, copied
into the reconstructed .17 SDK handlers package, run with:

```sh
go test ./sdk/api/handlers -run TestReview -v -count=1
```

Both counterexample assertions passed: PAID profile feature refusal reproduced,
and legacy free-only/SUB behavior confirmed. No real provider traffic.

Fix the PAID planner/refusal split and separate fallback eligibility from curation
first; then finish entitlement and client acceptance. Meeting-specific tuning
should use measured evidence rather than more profile names. No fixes or deployment
performed as part of this review.
