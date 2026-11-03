# Task profiles and preferred-model routing

The implementation adds a native task API surface. It is not a second gateway,
a plugin executor or a credential owner. Deployment status is recorded separately;
source/fixture completion does not mean the public endpoint has been deployed.

## Client contract

- `/v1/models`: full canonical catalog. Existing canonical IDs and qualified
  overrides retain their documented semantics.
- `/coding/v1/models`: a small curated coding view, backed by the same metadata,
  capability and economic eligibility checks used by execution.
- `/coding/v1/chat/completions`, `/coding/v1/messages`, `/coding/v1/responses`:
  native protocol handlers, API-key authentication and streaming. The requested
  model is a strong preference; the default is zero additional metered charge.
- No management API, image/audio/video endpoint, WebSocket or compacted provider
  state API is implicitly exposed under a task profile.

For an OpenAI-compatible client, use base URL
`https://code.nothing.pink/coding/v1` and keep its preferred canonical model ID.
For an Anthropic client, configure its base so its resulting request URL is
`https://code.nothing.pink/coding/v1/messages`; some clients append `/v1` themselves.
The same native API key is required. This does not change Cloudflare admin login.

A client can continue preferring Beam, GPT, Gemini or Qwen independently. An
explicit preference need not have benchmark records to run: its CURRENT native
capabilities, availability and no-charge permission must still pass. Automatic
alternatives require exact task evidence; missing data never invents an ability.
Unscored models remain available in the full catalog/normal endpoint, and a
client's explicit model preference can work during a metadata outage.

## Execution order

1. Try eligible providers/credentials for the requested model first. Native
   priority, weighting, affinity and cooldown handling operate within that model.
2. Rank eligible alternatives relative to the ORIGINAL requested model using the
   shared confidence-weighted, non-compensatory task-evidence policy.
3. Try models in that fixed rank order; use native credential selection within
   each. A high-priority credential for another model cannot promote that model.
4. Stop on terminal/uncertain errors, attempt exhaustion or request cancellation.
   Once streaming output is committed, never switch model/provider.

The original reference can use a registered unavailable or paid-only route to
establish identity; that does not authorize dispatch through it. The chain never
re-anchors to a failed alternative. When data cannot distinguish candidates,
uncertainty remains explicit and ties are deterministic, not round-robin.
No universal GLM-versus-MiniMax quality claim is made from missing benchmark data.

A model/capability/source/cost binding captured during planning is rechecked
before dispatch. Removed/repriced/replaced routes and revoked/expired allowances
cannot re-enter the plan under a reused credential ID. Opaque conversation state
blocks cross-model alternatives; native same-model affinity remains authoritative.
This is not a claim that every provider-managed state can move across providers.
Use the normal endpoint with a qualified override for explicit provider control.

Response headers identify `X-Gateway-Requested-Model`,
`X-Gateway-Resolved-Model`, `X-Gateway-Provider`, `X-Gateway-Profile`,
`X-Gateway-Model-Mode`, `X-Gateway-Cost-Policy` and
`X-Gateway-Similarity-Anchor`. Model IDs in the profile response have role `hint`;
its routing policy overrides the normal catalog's same-model paid-fallback label.

## Configuration

Merge into the existing config; never replace user provider/account settings:

```yaml
models:
  canonical-only: true
  canonical-routing:
    max-attempts: 8
    max-fallback-models: 3
    evidence-catalog: https://api.github.com/repos/anomalyco/models.dev/commits/dev
    evidence-cache: /home/agent/cliproxy-staging/state/model-evidence-cache.json
    evidence-max-age-hours: 168
    profiles:
      coding:
        task: coding
        max-models: 12
        cost-policy: free-only
```

With no profile map, `coding` is the built-in profile. Explicit maps define the
available profile slugs. Profiles are configuration-driven, validated and loaded
through the existing native config lifecycle. Full inference is unaffected by a
client merely choosing another catalog view or sending a forged profile header.
Profile context is assigned by the server-owned authenticated URL handler only.

Curation qualifies known task evidence; it does not rank all models globally on
one intelligence scale. Picker presentation can use native credential priority;
that does NOT override requested-model/similarity execution order. `max-models`
limits picker size, not explicit preferences. Expired metadata loses quality
ranking authority; source-bound historical task qualification can retain a useful
view during feed outages, with `evidence_stale: true`. Current native capability,
cost, account and cooldown gates remain mandatory. With no reference evidence,
there is no claim of a high-confidence similarity comparison.

## Zero additional charge

Free quotas and VERIFIED included subscription usage are eligible. Being logged
in with OAuth is not billing evidence. No paid overage, paid-credit draw, topup or
paid fallback is admitted. Unknown billing status is excluded from strict free-only.

Trusted producer `cost_tier: free` and native fresh zero-price catalog proof are
positive source-model evidence. Subscription/included routes additionally need
an explicit operator-owned allowance scoped to provider, native auth ID and exact
source models. For example (fake scope only):

```yaml
no-charge-allowances:
  - provider: codex
    auth-id: fixture-account-id
    source-models: [fixture-source-model]
    basis: "Provider-side no-overage setting verified; evidence reference"
    verified-until: "2026-11-04T00:00:00Z"
    no-paid-overage: true
```

This belongs under `models.canonical-routing`. It is an attestation of an actual
verified provider-side restriction, NOT a setting that turns provider billing off.
Do not configure it from authentication kind or an assumption about a plan. New
source models do not inherit an old allowance automatically. Expiry/revocation
is enforced at selection and at the physical dispatch guard, including a config
change after planning. Provider policy/price facts remain trust boundaries, not a
transactional guarantee against a provider changing its contract mid-request.
No production allowances were fabricated from existing OAuth accounts.

Model price alone also cannot authorize hosted-tool or premium-tier fees.
Strict free requests reject unverified hosted tools, provider-managed fallback
options, alternative upstream model arrays and premium/automatic service tiers.
Caller-executed function tools are allowed subject to capability checks. Explicit
normal-endpoint requests retain their separately documented cost permissions.

This hardens previous behavior: native OAuth and Gemini `free-tier` labels alone
no longer prove no-charge entitlement. Their accounts/settings are preserved;
normal canonical/qualified requests remain usable under their normal cost policy.

## Verification

The six original adversarial counterexamples are retained as passing regression
tests, supplemented by native profile/priority/reference-anchor tests, ingress
parser agreement, cost-receipt expiry/revocation and feature-cost guards. The
actual host fixture uses mandatory network isolation, fake credentials, existing
plugins and fake TLS providers. It exercises Chat Completions, Messages and
Responses streaming through the profile URLs, with exact physical dispatch counts.
These are integration tests, not new real-provider acceptance calls.
