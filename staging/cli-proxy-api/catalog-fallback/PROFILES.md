# Task profiles and preferred-model routing

The native coordinator exposes `chat` (general task) and `coding` profiles. Their
selection, billing, control API and telemetry contract is in
[SESSION-BILLING.md](SESSION-BILLING.md); brief client instructions are in
[docs/gateway-client-setup.md](../../../docs/gateway-client-setup.md).
Deployment state and artifact identity are recorded separately in the checkpoint.

Use `/chat/v1` or `/coding/v1` and retain each client's preferred canonical model.
Or use the normal base `/v1` with the explicit virtual alias `chat` or `coding`.
For Anthropic clients that append `/v1/messages`, the base omits `/v1`.
The existing inference key is required; admin browser authentication is separate.

Profile selection is preferred-model first, then similarity to that ORIGINAL
reference. Credential priority and weights act within each model and admitted
billing class. No global cross-model credential priority or round-robin pool can
override model similarity. Unknown comparative evidence stays uncertain; family
continuity is not proof of opaque state portability.

Billing permission defaults to SUB, independently of task curation. PAID must be
explicitly selected for a session; `:free` narrows one request to FREE. Ordinary
model IDs on the normal API stay binding, including those with `:free`. Only
profile URLs and explicit virtual aliases authorize cross-model substitution.

Profiles filter the native protocol-specific model serializers, preserving options
and reversible Anthropic aliases. The full catalog remains available. Explicit
preferences need not appear in the small curated view or have benchmarks: current
route capabilities, availability and economic permission remain mandatory.
Historical source-bound task evidence can retain curation during a metadata outage;
expired evidence loses quality-ranking authority and is marked stale. No universal
quality ordering or conversational warmth measurement is invented.

The rollout merges these fields into existing configuration, preserving other
profiles and provider/account settings:

```yaml
models:
  canonical-routing:
    profiles:
      chat:
        task: general
        max-models: 12
        preferred-model: nemotron-3-ultra-550b-a55b
        cost-policy: session
      coding:
        task: coding
        max-models: 12
        preferred-model: glm-5.3-flash
        cost-policy: session
```

`preferred-model` defines the virtual alias's initial preference. A concrete model
supplied through a profile URL overrides that default. `max-models` limits picker
size, not explicit model preferences. A viable configured preference is shown
first and labelled `profile_preferred`, even if exact-source benchmark data is
missing; it is labelled as operator preference, not benchmark proof. Alias defaults are operator choices, not
live quality acceptance claims. A real registered model cannot be shadowed by an
alias. Opaque/compact continuation requires an explicit model instead of an alias.

No-charge proof is account/source scoped and expiring. For operator configuration,
`no-charge-allowances` lives under `models.canonical-routing`:

```yaml
no-charge-allowances:
  - provider: fixture-provider
    auth-id: fixture-account-id
    source-models: [fixture-source-model]
    billing-class: SUB
    basis: "Actual provider-side included allowance/no-overage proof reference"
    verified-until: "2026-11-05T00:00:00Z"
    no-paid-overage: true
```

Only configure this after verifying the real provider/account restriction. It
cannot turn billing off. FREE receipts require positive free-account evidence;
SUB receipts require verified included subscription allowance. OAuth and a
free-tier label alone prove neither. New source models inherit no old receipt.
Revocation/expiry is checked again at physical dispatch, even after planning.
No production receipt is invented by the implementation or deployment helper.
