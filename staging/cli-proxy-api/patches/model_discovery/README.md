# Opt-in free catalog discovery (native.8)

Prepared from the reviewed native.7 tree by `prepare_model_discovery.py`.
This extends native model registration; it adds no external service or secret store.

For each native OpenAI-compatible provider:

```yaml
model-discovery:
  enabled: true
  free-only: true
  refresh-seconds: 900
```

The service fetches `/models` with one existing API-key credential per provider.
New models need explicit zero pricing or a recognized provider's free-ID contract;
unknown and positive pricing are excluded. Requesty price bands must all be zero.
Manual selections and aliases remain authoritative, including explicit paid routes.
Successful refreshes withdraw automatic models that disappear or become paid;
failed refreshes retain the last good catalog. Catalog snapshots are in memory.
This is catalog admission, not a per-request billing cap or guaranteed entitlement.

FreeHub uses its existing provider-specific catalog callbacks, scheduled by:

```yaml
plugins:
  model-refresh-seconds: 1800
  model-refresh-providers: [freehub]
```

LLM7 admits free/turbo models explicitly marked not usage-based; Pro models are
excluded. Vercel requires explicit zero pricing. Other FreeHub vendor policies
remain provider-specific: a free account allowance differs from a zero list price.
OpenCode is excluded from periodic callbacks and its quarantine is preserved.

All refreshes are metadata-only; no inference, token refresh, config rewrite,
credential rotation or redirects. Refresh publication preserves native per-auth
quota/suspension state and rejects stale config/credential epochs.

Verification: focused `go test ./sdk/cliproxy -run '^TestCatalogAuto' -race -count=1`
in the prepared tree, focused FreeHub catalog tests, and the existing isolated host
smoke with `--catalog-discovery`. The latter verifies automatic publication,
manual alias preservation, paid exclusion, and dispatch of an automatically added
model against a network-isolated fake provider. It does not prove live entitlement.

## Catalog-backed canonical identities (native.9)

Configure exact routes in each existing provider's `model-discovery` block:

```yaml
aliases:
  - name: z-ai/glm-5.3-flash-free
    alias: glm-5.3-flash
    is-compat: true
```

The provider must have `enabled: true` and `free-only: true`. Aliases are added
only if the exact source is in the successfully fetched, free-admitted snapshot.
Source/qualified IDs remain available. Manual aliases win; conflicting multiple
sources for one canonical alias in the same provider fail closed. Native alias
resolution sends the original source ID, including its free suffix. No model-name
normalizer, second dispatcher, same-request replay or free-to-paid fallback exists.

Aliases disappear after removal/price change and reappear when the exact eligible
source returns. Two failed refresh periods expire automatic models and aliases
(30minutes at the deployed15minute interval); explicit manual selections remain.
A successful empty catalog also withdraws automatic routes. Credential/provider
removal is owned by native registration epochs. Publication retains native quota
state; catalog reconciliation never resets account cooldowns or runs inference.

FreeHub uses its existing vendor-scoped model-alias setting and additive alias
publication. Runtime registration uses the vendor's current filtered model list;
a removed/free-policy-ineligible source provides no canonical route for that auth.
No free/public fallback is enabled for OpenCode, and no quarantined record changes.

Focused tests cover native exact reverse dispatch, manual override, source removal,
price increase, empty catalog, return, stale expiry, qualified-ID preservation,
FreeHub vendor boundaries and alias lifecycle. The isolated host fixture sends one
mock canonical request, checks its exact upstream ID, removes the source, verifies
rejection before dispatch, restores it, and checks publication without extra
provider inference. All network traffic remains inside an isolated namespace.
