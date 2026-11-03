# Catalog-backed fallback: implementation draft

This is a **reviewable, opt-in native extension**, not an installed/deployed plugin.
Production remains native .14. The draft replaces name-based fallback ranking
inside the existing coordinator; it does not introduce another inference proxy,
credential store, executor, account scheduler, or refresh owner.

Read [ARCHITECTURE.md](ARCHITECTURE.md) for the decision rationale and boundaries.

## Package

- `policy/`: typed protocol requirements, immutable public-catalog snapshots,
  exact identity resolution and evidence-aware alternate-model ranking.
- `host/`: narrow CLIProxyAPI adapters for native availability, capability/source
  fencing, diagnostics and the existing catalog-updater lifecycle.
- `prepare.py`: creates a NEW scratch backend from the reviewed pinned .9 source
  using the existing canonical preparation. It does not edit a deployed tree.
- `policy/live_cache.go` and `github_catalog.go`: native live refresh, conditional
  HTTP, bounded data-only GitHub parsing and atomic disk-cache persistence.
- `refresh_modelsdev.py`: optional data-only public repository snapshot importer, with
  commit/archive provenance and atomic output. No upstream code/Git execution.
- `cmd/`: catalog validator, public-metadata refresh and offline request/route
  preview, never an inference client. Credential handles are omitted from diagnostic JSON.
- `prepare_smoke.py`: derives an evidence-enabled scenario from the shared
  network-isolated actual-host fixture, rather than copying its supervisor.

## Policy

Exact-model free routes are still tried first. Plain canonical IDs retain their
same-model free-to-paid behavior, with paid OpenRouter last. This extension only
assembles cross-model alternatives for `:free`; exact overrides remain unchanged.
All eligible free providers use native credential selection, without a brand bonus.

1. Native coordinator owns permission to continue, selected-attempt limits,
   terminal-error handling and no fallback after streaming output.
2. Current native route state/capabilities/cost authorize candidates. External
   metadata cannot create routes, admit costs, release holds or refresh tokens.
3. Resolve identity using exact `(provider, final source ID)` catalog links.
   Internal display/prefix/cooldown keys are not the upstream identity.
4. Infer only defensible task requirements: tools/history imply agent/tool-use;
   JSON implies structured work; requested reasoning implies reasoning; otherwise
   general. The pure API can take an explicit task; no prompt classifier is used.
5. Compare task-specific published benchmark evidence. Known differences in
   benchmark version, harness, settings or dataset prevent comparison. Missing
   settings reduce confidence instead of erasing the result. Unclear score units,
   unsupported metrics, contradictory duplicate reports and missing values stay
   unknown; scores from unrelated benchmarks are never directly compared.
6. Rank by confidence-weighted expected degradation, using a conservative unknown
   loss prior rather than giving every measured model precedence over unknowns.
   Coverage, independent benchmark count and available evaluation settings affect
   confidence. Family continuity remains a publisher-scoped soft tie-breaker.
7. Passive exact-route latency and declared transport-domain hints can help break
   ties and diversify the shortlist. The draft native adapter supplies domain
   hints but does not manufacture latency/quality telemetry or run probes.
8. Final native dispatch binding includes a normalized capability fingerprint,
   in addition to source/cost identity and its single-use physical permit.

Named `comparable` means comparable database records, **not independent validation
or guaranteed runtime quality**. Current Models.dev benchmark evidence is treated
conservatively as reported evidence. Provider serving settings/quantization and
request reasoning budget may differ from the benchmark. The optional pure-library
loss bound constrains comparable database evidence; it is not an inference SLA.

## Real data readiness

The importer was exercised on a real public Models.dev commit, not just fixtures.
It exposes a concrete coverage limit: GLM5.3Flash has some fully specified
benchmark records, while GLM4.7Flash and MiniMaxM3.1Flash do not currently supply
sufficient matching records for the requested pairwise judgment. The draft will
not claim to know which is better from that snapshot.

An additional evidence adapter/feed is needed before claiming reliable quality
ordering for those models. There is no authenticated LLM Stats/Hugging Face
benchmark enrichment adapter in this draft; no credentials were requested and
no data was fabricated. The normalized catalog boundary permits one later.

## Configuration (candidate only)

Merge these fields into existing settings; never replace a live config wholesale:

```yaml
models:
  canonical-only: true
  canonical-routing:
    max-attempts: 8
    max-fallback-models: 3
    evidence-catalog: https://api.github.com/repos/anomalyco/models.dev/commits/dev
    evidence-cache: /absolute/existing/state/directory/model-evidence-cache.json
    evidence-max-age-hours: 168
    require-comparable-evidence: false
```

The gateway refreshes on startup and the existing native three-hour catalog
cadence. There is no network lookup or cache write during inference. The cache
parent directory must exist and be writable by the gateway owner.

Two explicit live sources are supported: `https://models.dev/catalog.json`, and
the GitHub commit endpoint shown above. The JSON endpoint still returns 403 from
this development environment; native GitHub refresh was exercised successfully.
It resolves the current commit, downloads its immutable archive only when needed,
parses bounded TOML metadata using the host's existing TOML dependency and records
commit/archive provenance. It never executes upstream code or extracts files.
There is no hidden source switch, browser spoofing or paid feed.

HTTP ETag/Last-Modified validators avoid unnecessary downloads. Valid 304 responses
renew the origin-validation time. Valid 200 responses atomically replace complete
snapshots. Invalid/oversized responses, redirects, fetch errors and rate limits
retain the last valid cache **without renewing its age**. Private 0600 disk writes
use a temporary file and atomic rename. A valid source-bound disk cache bootstraps
memory on restart before the first background network request finishes. Disk-write
failure retains fresh memory and logs the loss of persistence.

Expired evidence loses ranking authority at the configured maximum age; compatible
unknown-quality last resorts remain possible unless strict evidence is enabled.
Provider route removal, repricing and cooldowns are enforced separately by native
state even when metadata is cached. Source/cache configuration changes reuse the
native updater's cancellation and generation fencing. No new platform watcher,
cron, schedule or production configuration was created.

Absolute timestamped local files are still supported for offline/operator use.
An absent/disabled source disables alternate-model assembly in this candidate.
The live disk envelope is not the same as an imported local catalog JSON; use the
live URL plus `evidence-cache` for automatic operation.

The metadata-only CLI exercises the same live code without provider calls:

```sh
go run ./cmd/catalog-fallback-preview \
  --refresh-source https://api.github.com/repos/anomalyco/models.dev/commits/dev \
  --cache /absolute/existing/state/directory/model-evidence-cache.json --check
```

The data-only refresh command can be invoked by existing authorized automation:

```sh
python3 staging/cli-proxy-api/catalog-fallback/refresh_modelsdev.py \
  --output /absolute/path/modelsdev-evidence.json
```

A failed download/parse never overwrites the previous output. HTTP sources reject
redirects and use fixed approved hosts. Repository aliases are resolved only
inside the bounded in-memory archive; nothing is extracted onto the filesystem.

`free-fallbacks` lists are accepted for config compatibility but are intentionally
not used by this replacement policy. No hand-maintained model fallback list is
required. Operator intent should be expressed as constraints, not model-name order.

## Build and verification

```sh
python3 staging/cli-proxy-api/catalog-fallback/prepare.py \
  --source /tmp/cliproxy-identities-a --output /tmp/catalog-fallback-NEW
cd /tmp/catalog-fallback-NEW
go test -race ./internal/catalogfallback ./sdk/api/handlers \
  ./sdk/cliproxy/auth ./sdk/cliproxy ./internal/registry \
  ./internal/modelidentity ./internal/pluginhost \
  -run 'TestDraft|TestReviewSimilarityCapability|TestCanonical|TestAdversarialReview|TestCatalogDiscovery|TestDiscoveryCatalog' -count=1
go build -o /tmp/catalog-fallback-native ./cmd/server
go run ./cmd/catalog-fallback-preview --catalog /absolute/path/evidence.json --check
```

The prior name-score implementation and its implementation-specific tests are
replaced only in the NEW scratch tree. Native safety/control tests stay. Their
fixture explicitly enables the opt-in engine. The capability-revocation repro
from the earlier adversarial review is retained as a passing regression.

The isolated harness uses fake credentials, fake benchmark data and loopback TLS
providers, with mandatory `bwrap --unshare-net` and exact existing plugin hashes:

```sh
python3 staging/cli-proxy-api/catalog-fallback/prepare_smoke.py \
  --output /tmp/catalog-fallback-smoke-NEW.py
python3 /tmp/catalog-fallback-smoke-NEW.py \
  --binary /tmp/catalog-fallback-native \
  --plugin /tmp/freehub-canonical-hardening-production.so \
  --opencode-plugin /tmp/opencode-native-parity-031.so \
  --canonical-policy --output /tmp/catalog-fallback-host-NEW
```

Do not run old deployment/live journals. Passing this draft's fixtures does not
establish real provider/model quality or authorize an OpenCode inference.

## Verified outcome

The draft builds. Focused Go race tests and four data-import tests pass. The
actual native host, with both existing plugins and mandatory network isolation,
passes the fake-provider end-to-end scenario: plain same-model paid fallback,
`:free` alternate model, hidden exact-source override, opaque-state refusal,
source/cost boundaries and preserved disabled OpenCode state (six mock POSTs).
The real public snapshot imports and decodes 849 models / 220 providers.

See [evidence/verification.json](evidence/verification.json),
[evidence/isolated-host.json](evidence/isolated-host.json), and
[SOURCE-PINS.md](SOURCE-PINS.md). These are synthetic integration and data-import
results, **not real provider quality/live acceptance**. No production change was
made; deployed .14 still has the previously recorded review findings.

## Confidence semantics

The weight is an explicit routing heuristic, **not a calibrated probability**.
Missing version/harness/variant/dataset multiply evidence weight by 0.8/0.7/0.75/0.9;
known conflicts exclude the pair. Each independent benchmark contributes at most
once; repeated reports, variants and credentials cannot inflate support. Prefer
best-established comparable conditions and take the worse degradation on ties.
Confidence combines setting completeness, reference coverage and saturating
benchmark support `n/(n+1)`. A single useful result contributes without claiming
full coverage. Sorting is deterministic.

`risk_loss = confidence * observed_mean_loss + (1-confidence) * 0.25`.
Lower ranks first. The 0.25 unknown-loss prior is conservative policy, **not an
empirical estimate**; tune it only with real downstream evaluation. Unknown models
can therefore outrank a model with strong evidence of a severe regression.
Strict comparable mode and explicit loss bounds retain their stronger evidence
requirements. Neither the score nor the live cache supplies benchmarks absent
from the upstream data; MiniMax's missing records remain missing.
