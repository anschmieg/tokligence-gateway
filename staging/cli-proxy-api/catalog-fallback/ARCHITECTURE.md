# Architectural decisions and their high-level intent

## 1. Preserve one inference and credential authority

**Why:** the goal is a useful mainline CLIProxyAPI gateway with lower maintenance,
not another proxy or independently refreshing plugin.

**Right high-level choice:** a policy proposes alternatives; the existing owner
continues to authorize, select and execute physical attempts.

**Draft:** a pure in-tree policy package plus narrow adapters to the existing
canonical coordinator. The pinned v8.0.49 SDK `ModelRouter.RouteModel` returns a
pre-selection target. `Scheduler.Pick` chooses credentials; lifecycle events are
terminal/asynchronous. Neither exposes an ordered, post-failure alternate-model
policy with final per-attempt safety fencing. A standalone executor would have to
duplicate credential/dispatch/retry logic or lose those invariants.

This is explicitly custom backend code, not stock YAML or a loadable `.so`.
Retire the adapter when upstream exposes an equivalent bounded fallback-policy
hook; keep the source-independent policy behind that hook.

## 2. Separate model facts, route permissions and live state

**Why:** model quality, a provider's API capabilities, and an account's free
entitlement are different facts. Combining them caused previous routing mistakes.

**Right choice:** third-party facts advise ranking; native runtime state authorizes
routes. Trust must not flow from a public price table into credential permissions.

**Draft:** the catalog never registers models, keys or aliases. Native registry,
manager, cooldowns and cost receipts remain authoritative. The same-model phase
keeps native provider selection. Alternate-model proposals contain an explicit
eligible-route allowlist, so a slower/incompatible/excluded route cannot re-enter
merely because another route serves the same canonical model.

## 3. Use exact externally declared identity, never fuzzy name equivalence

**Why:** benchmark scores for the wrong revision or weights can be worse than no
scores. Operator prefixes are not model identity.

**Right choice:** joins carry publisher/model/version provenance and unresolved
joins stay unresolved.

**Draft:** resolve only Models.dev's exact provider/source-to-canonical links.
The bridge prefers the plugin's explicit source after decoding its known vendor
transport wrapper, or the native final upstream source, over decorated metadata
keys. Publisher namespaces and unknown wrappers are preserved. Families are explicit and publisher-scoped;
unknown namespaces do not become a shared family. Conflicting known identities
inside a canonical group are refused. If an eligible route has unresolved
identity, the model's quality prior remains unknown rather than borrowing another
credential's proof. This conservative choice can reduce coverage; it is visible,
not fixed through guessed aliases or provider favoritism.

## 4. Architecture is provenance, not a substitute for evaluations

**Why:** parameter count, MoE vs dense attention or a shared family name do not
establish coding, reasoning or tool-use quality. They also do not prove signature
compatibility.

**Right choice:** retain lineage/variant information; judge task ability using
actual evidence where available.

**Draft:** architecture/name-size bonuses are removed. Explicit lineage is only a
soft tie-breaker after comparable task evidence. No attention-layout or parameter
count score is invented. Published model-level priors do not certify the serving
provider's quantization, reasoning settings or hidden implementation.

## 5. Compare evaluation records, not leaderboard headlines

**Why:** numerical scores from different datasets, harnesses and inference budgets
are not interchangeable. Missing results must not be treated as failure or zero.

**Right choice:** preserve provenance and conditions, expose uncertainty and avoid
filling gaps with a synthetic universal intelligence number.

**Draft:** a small benchmark-category taxonomy (not per-model profiles) selects
relevant evidence. Comparisons require the same benchmark/version/harness/variant/
dataset/metric. Recognized unambiguous percentage records are normalized; null,
ambiguous fraction/percentage values, arbitrary Elo and descriptive strings are
not converted. Duplicate conflicting evaluations are discarded.

`comparable` requires at least two matching records covering the reference set;
`partial` retains coverage but does not pretend differing matched subsets form
one precise quality ordering; `unknown` is an explicit last resort. These are
record-comparability bands, not statistical confidence intervals. Current records
are conservatively described as publisher-reported priors. A strict pure-library
loss bound rejects incomplete evidence but still is not a runtime quality SLA.

## 6. Let the request establish requirements without exporting its contents

**Why:** guessing that every agent is coding is unreliable; running a classifier
would add inference cost, latency, data disclosure and another dependency.

**Right choice:** hard protocol constraints first, modest task inference from
explicit structure, and an optional explicit task at the pure API boundary.

**Draft:** tools/history imply agent work; structured output and reasoning select
corresponding categories; otherwise general. Messages, actual content parts and
native generation settings are parsed separately from tool schemas/arguments and
result payloads. Exact reasoning levels/budgets and schema requirements are
retained. Native thinking suffixes are interpreted using native parsers and checked
against alternatives, rather than reduced to one reasoning boolean.

Recognized signed/encrypted/server-managed state refuses cross-model substitution.
Native-supported signatures nested under tool `function` extras are included.
Nothing is removed from the conversation to make a candidate fit. Original-model
provider selection is unchanged; this is not a universal guarantee that opaque
state can move between providers or that every future state format is recognized.

## 7. Use the native catalog-refresh lifecycle and immutable snapshots

**Why:** no external lookup should block inference, and data-source outages must
not take down otherwise usable model routes.

**Right choice:** validate whole snapshots off the inference path; publish
atomically and retain last-good data without pretending stale data is fresh.

**Draft:** reuse the native generation-fenced catalog updater. A process-local
atomic snapshot contains public metadata only. File snapshots retain their actual
retrieval timestamp across reloads/restarts. Metadata-source changes cannot reuse
another source's snapshot. Malformed/oversized/duplicate-key updates are refused.
Expired evidence loses ranking authority; strict mode can refuse unknown quality.
The route registry remains independently authoritative for model removal/repricing.

The public JSON endpoint was not accessible from this environment, so a tested
data-only GitHub snapshot importer is supplied as an alternative. It pins commits,
records archive hashes, limits size and resolves data aliases only inside the
archive. It never executes downloaded code or extracts filesystem paths. No new
platform timers/watchers are installed; source automation is a deployment choice.

## 8. Preserve native availability semantics and dispatch fencing

**Why:** stale short-lived markers must not exclude recovered routes forever;
durable holds and account ownership must remain untouched.

**Right choice:** an eligibility read understands expiry, while native auth state
and dispatch remain authoritative. Checking a cached model once is insufficient.

**Draft:** native auth blocked-state checks plus an expiry-aware registry read;
no resume, cooldown clearing, refresh or probe. The final immutable source/cost
binding now includes a normalized capability fingerprint. Revocation between plan
and final admission fails before executor invocation. The final guard is the
admission commit point; later metadata changes do not retroactively cancel an
already admitted/sent inference. There is no claim of transactional control over
an upstream provider changing its model during a request.

## 9. Keep operational knowledge passive, scoped and honest

**Why:** benchmark quality and provider health are different; more credentials
must not inflate a model's apparent quality.

**Right choice:** observed exact-route latency, known failure scopes and remaining
budget help choose among suitable models, without background probes.

**Draft:** the pure API accepts passive route p95 latency and failure-domain hints.
A model's conservative latency covers all remaining eligible routes; unknown is
not zero. The native draft currently supplies owner/transport hints, not a new
telemetry collector or invented latency. Domain diversity only reorders equivalent
evidence/quality bands. It does not assert that different resellers have independent
upstreams. Credential duplication does not increase evidence or quality scores.

The native coordinator retains bounded attempts, terminal errors, no post-output
fallback and per-attempt eligibility checks. Ranking uses one consistent metadata
snapshot per request; the initial adapter does not re-score quality after every
failed attempt. Integrating richer failure-scope/passive telemetry can use the pure
API later; this draft does not claim it is already wired.

## 10. Start with a useful public adapter, not an ecosystem of integrations

**Why:** maintaining our own benchmark DB or several authenticated adapters would
recreate the maintenance burden the user rejected.

**Right choice:** one maintained public source first, with an explicit evidence
boundary for an additional feed only when coverage justifies it.

**Draft:** Models.dev canonical metadata and source-attributed benchmark records,
MIT notice retained. No paid API, account provisioning, inference evaluation jobs,
LLM Stats/HF scraping or untested authenticated adapter. Real target-model coverage
was checked and is insufficient for the requested GLM4.7/MiniMax3.1 comparison.
That is a data-readiness gate before claiming intelligent production ordering,
not a reason to guess. The next adapter should fill that measured gap, preserve
licensing/provenance and avoid introducing a second model identity database.

## 11. Make the result inspectable without creating another admin product

**Why:** operators need to understand fallback choices, but not another dashboard
or a log containing prompts and credential handles.

**Right choice:** reuse native config/logging and provide a small offline preview.

**Draft:** opt-in fields under `models.canonical-routing`, sanitized decision
explanations containing public model IDs/evidence bands/coverage only, and a
no-network dry-run CLI. No sidebar, new public management route, prompt logging,
browser secret, or replica of the existing native management UI is added.
