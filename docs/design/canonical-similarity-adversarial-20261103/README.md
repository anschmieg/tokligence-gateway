# Reproducing this review

All credentials, signatures, auth IDs, providers and executor responses here are
fixtures. These are invariant tests expected to FAIL on the reviewed .14 source.
Nothing should run against production or a real provider.

Prepare a NEW scratch source from the pinned reviewed .9 base:

```sh
python3 staging/cli-proxy-api/prepare_canonical_catalog.py \
  --source /tmp/cliproxy-identities-a --output /tmp/similarity-review-NEW
```

Copy `handlers_repro_test.go.txt` to that source's
`sdk/api/handlers/review_similarity_repro_test.go`,
`auth_repro_test.go.txt` to `sdk/cliproxy/auth/review_similarity_repro_test.go`,
and `registry_repro_test.go.txt` to `internal/registry/review_similarity_repro_test.go`.
Run within that scratch source:

```sh
go test -race ./sdk/api/handlers ./sdk/cliproxy/auth ./internal/registry \
  -run '^TestReviewSimilarity' -count=1
```

The quota test changes a timestamp in its own fake in-memory registry; no sleep,
real cooldown, credentials, live inference or configuration changes are needed.
`results.txt` records six invariant failures. `controls.txt` records the passing
source/cost/budget/free-only/stream controls; `manifest.json` pins reviewed inputs.
