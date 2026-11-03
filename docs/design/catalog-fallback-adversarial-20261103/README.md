# Adversarial evidence for catalog-backed fallback draft

Reviewed source: `2ec1410`. Production and draft implementation were not changed.
All credentials, scores and executor responses are fake. No provider HTTP was sent.
The six failing assertions are archived as `.go.txt` so they do not break unrelated
repository checks. Results reflect six demonstrated counterexamples, not a
universal safety/quality assessment. Cache/guard controls passed under the race detector.

Reproduce in a NEW scratch tree prepared by the draft's `prepare.py`:

1. Copy `policy_repro_test.go.txt` and `protocol_repro_test.go.txt` into
   `internal/catalogfallback/` using their `.go` suffixes.
2. Copy `handlers_repro_test.go.txt` into `sdk/api/handlers/` as a `.go` test.
3. Run `go test ./internal/catalogfallback ./sdk/api/handlers -run
   '^TestAdversarialLogic' -v -count=1`. Expected: six assertion failures.
4. The control filter is recorded in the accompanying report. Do not run any old
   deployment, login or live inference helper to reproduce this source review.
