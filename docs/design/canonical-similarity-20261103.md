# Context-aware canonical free fallback similarity

The request's exact model and all eligible free providers are still attempted
first. This ranking concerns the alternate models for `:free` only; plain IDs
still fall back to paid routes for the same model, and provider overrides retain
exact behavior. All free providers remain peers under native selection.

The ranker is local, deterministic, and rebuilt from current registry metadata
for each request. It adds no discovery probes, classifier inference, embeddings
service, database, session store, timers, or quality/latency benchmark claims.

## Compatibility and conversation continuity

Hard gates precede scoring. A candidate needs an admitted free route, declared
text input/output and required modalities/parameters/reasoning, sufficient context
(using serialized request bytes as a conservative text-size estimate plus the
requested output), and sufficient declared output limit when explicitly set.
Unknown mandatory capabilities fail closed. Opaque media/doc input and known
non-chat endpoints are not substituted. Historical tool calls/results imply tools
are required even if the current caller omitted tool definitions. Unsigned
reasoning history requires reasoning support. These are declarations, not proof
that every provider implements every declared capability correctly.

Portable tool loops, unsigned reasoning history and two or more assistant turns
activate a same-family continuity class. Members still must pass every hard gate.
If none are compatible, other families are eligible. The last slot of an otherwise
all-same-family shortlist is reserved for the best compatible different-family
rescue (with limit >1). This avoids spending the entire bounded shortlist on a
single family while retaining closer family choices first.

Recognized signed thinking, Gemini thought signatures, encrypted/redacted reasoning,
Responses reasoning IDs/item references/previous-response or conversation handles,
and server-managed built-in tool items disable cross-model substitution entirely.
Family resemblance does not establish signature or server-state compatibility.
No fields are stripped or rewritten. Exact-model native selection is unchanged;
this feature does not certify that provider-bound opaque state can move between
providers of the same model. Unknown custom state formats cannot be guaranteed
portable merely because they are not among the recognized fields.

## Scoring contract

Within the continuity class, sum observable feature contributions:

- Family match: +180. Novel families derive distinct identities from model names;
  there is no shared unknown-family bucket.
- Same-family numeric generation: up to120, using distance
  `8*abs(major difference) + abs(minor difference)` and `120/(1+distance/4)`.
  Dates and parameter-count/context-size tokens are not versions.
- Model-name token Jaccard overlap: up to100; generic chat/instruct/free/preview/
  latest markers are ignored. Namespace publishers are not family identity.
- Requested model's named coding/math specialization: matching +220, otherwise
  -200. This is a name-derived role hint, not a measured coding/math score.
- Fast/large naming profile: matching +70, different known profiles -35.
- Known parameter-count scale proximity: up to60.
- Declared context proximity: up to100; output-limit proximity: up to80.
- Supported-parameter Jaccard overlap: up to100; input and output modality
  overlap: up to40 each; declared reasoning-profile agreement: +60.
- Optional configured family/default preference: `200/(position+1)`.

Positive scale proximity is symmetric logarithmic distance,
`weight/(1+abs(log2(source/candidate)))`; unknown dimensions contribute zero.
Larger numbers do not automatically mean better. Numeric versions are compared
within a family only; unrelated version schemes are never equated.

Score every compatible, non-suspended free route of the candidate and use the
minimum score. Thus route metadata is never combined into an impossible union,
native credential selection remains independent, and duplicate credentials do
not boost model rank. Known native registry holds are excluded without clearing
or probing them. Native selection still makes the authoritative availability
check, and final per-credential cost/source binding remains enforced.

Sort by continuity class, then descending score, then ascending ID only to break
exact ties. The default is at most3 alternate models /8 total selected attempts;
hard maxima6/12 remain. Metadata changes, removal, repricing and registered
suspensions affect the next request; no stale fixed chain is retained. Per-attempt
capability/cost binding checks still guard changes after ranking.

Debug logging contains model IDs, feature contributions and continuity flags
only. It never contains request text, tool arguments, signatures or credentials.

## Focused acceptance

Permanent fake-only tests cover numeric 9/10 ordering, date/parameter parsing,
new/removed/repriced models, cross-family coding specialization, family continuity
with tool history, incompatible-family exclusion, cross-family rescue slots,
suspensions, deterministic ties, route metadata distance, credential duplication,
non-chat/unknown capability exclusion, portable reasoning and multi-turn history,
and multiple opaque-state formats with no cross-model executor calls.

The existing actual-host smoke additionally exercises opaque previous-response
history with no cross-model dispatch, alongside free-to-paid, free-only,
source-alias collision, exact override, unknown-free refusal and disabled
OpenCode preservation. The fixture has mandatory network namespace isolation,
fake credentials and loopback providers. It does not establish real model quality,
all-provider parity, or safe replay of opaque state on another provider.
