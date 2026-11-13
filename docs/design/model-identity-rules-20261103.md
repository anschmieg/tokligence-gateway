# Reviewed canonical identities — November 3

This is an explicit identity map, not fuzzy model-name normalization. Original
qualified model IDs remain available. New variants require review before merging;
known source additions/removals/pricing changes are reconciled automatically.

- `nemotron-3.5-lightning`: retain Kilo/OpenRouter, add Requesty's exact
  `nvidia/nemotron-3.5-lightning-30b-a3b` free source. All three lanes already
  have representative live acceptance. Native OpenRouter and Requesty aliases
  are now catalog-backed rather than unconditional static canonical entries.
- `glm-5.3-flash`: LLM7's exact `llm7/GLM-5.3-Flash` free-tier source and Orca's
  exact `z-ai/glm-5.3-flash-free`. The base paid Orca ID and Uno's thinking/search
  variants remain separate. No NVIDIA, quarantined OpenCode, or other unknown
  variant is silently admitted. LLM7 identifies this model as Z.ai on its own
  model page; Orca's official free route names the same exact version/variant.

Sources: [LLM7 model](https://llm7.io/models/glm-5-3-flash-e8f0d28d/),
[Orca free routing](https://docs.orcarouter.ai/routing/free-models),
[Requesty free catalog](https://www.requesty.ai/models/free),
[Requesty NVIDIA catalog](https://www.requesty.ai/models/nvidia).
These are provider-declared identities, not independent weight/quantization audits.
Provider-specific prompt caps, free allowances and capacity can still differ.

Native configuration adds `model-discovery.aliases` per provider. The existing
native dispatcher/credential selector, retries, cooldowns and prefix handling own
execution. Only publication/exact alias resolution are extended. The existing
FreeHub alias API configures one LLM7 alias; plugin code and credentials are not
replaced. Existing priorities stay unchanged: free OpenRouter shares the native
free tier, while explicit PAYGO remains a separate low-priority group.

Successful fresh catalogs gate canonical publication. Removed or newly paid
sources disappear; returning exact free sources reappear. No canonical route is
created from a guessed replacement ID. A transient native catalog failure retains
last-good metadata for up to two configured refresh periods, then expires automatic
models/aliases; manual explicit selections stay operator-owned. FreeHub's model
callbacks and vendor filtering govern its eligible registrations. Published shared
metadata uses the existing conservative capability intersection across providers;
unknown limits/features remain unknown. Adding multiple different FreeHub vendors
to one canonical ID is deferred until per-credential capability intersection has
been addressed; only Kilo supplies FreeHub's Lightning route and only LLM7 supplies
FreeHub's GLM route in this slice.

No new live provider inference is required or claimed. Exact-artifact isolated
host dispatch/lifecycle checks and focused custom race tests validate the change.
Rollout evidence records actual publication, protected state, accounts, qualified
IDs, config preservation and the single native runtime owner.
