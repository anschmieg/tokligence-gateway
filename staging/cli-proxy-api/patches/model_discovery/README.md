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
