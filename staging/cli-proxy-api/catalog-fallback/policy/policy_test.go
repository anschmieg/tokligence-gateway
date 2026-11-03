package catalogfallback

import (
	"encoding/json"
	"reflect"
	"sync"
	"testing"
	"time"
)

var fixtureNow = time.Date(2026, 11, 3, 12, 0, 0, 0, time.UTC)

func fixtureCatalog(t *testing.T) *Snapshot {
	t.Helper()
	benchmark := func(name string, score int) map[string]any {
		return map[string]any{"name": name, "score": score, "metric": "pass@1", "version": "fixture-v1", "harness": "fixture-agent", "variant": "fixture-default", "source": "https://example.org/publisher-results"}
	}
	model := func(id, family string, a, b int) map[string]any {
		return map[string]any{"id": id, "family": family, "benchmarks": []any{benchmark("Terminal-Bench", a), benchmark("DeepSWE", b)}}
	}
	root := map[string]any{"models": map[string]any{"lab/glm-5.3-flash": model("lab/glm-5.3-flash", "glm", 90, 80), "lab/glm-4.7-flash": model("lab/glm-4.7-flash", "glm", 60, 55), "other/minimax-3.1": model("other/minimax-3.1", "minimax", 88, 82)}, "providers": map[string]any{"fixture": map[string]any{"models": map[string]any{"glm-source": map[string]any{"canonical_model_id": "lab/glm-5.3-flash"}, "older-source": map[string]any{"canonical_model_id": "lab/glm-4.7-flash"}, "other-source": map[string]any{"canonical_model_id": "other/minimax-3.1"}}}}}
	b, _ := json.Marshal(root)
	s, err := DecodeModelsDev(b, fixtureNow)
	if err != nil {
		t.Fatal(err)
	}
	return s
}
func fixtureCaps() Capabilities {
	return Capabilities{Chat: true, Context: 32768, Output: 4096, Tools: true, ToolChoice: true, Parallel: true, JSON: true, StructuredJSON: true, Reasoning: true, ReasoningLevels: []string{"low", "high"}, BudgetMax: 4096, DisableReasoning: true, InputModalities: []string{"text"}, OutputModalities: []string{"text"}}
}
func fixtureRoutes() []Route {
	return []Route{{ID: "source", ModelID: "glm-5.3-flash", Provider: "fixture", SourceID: "glm-source", Capabilities: fixtureCaps(), Free: true, Available: true},
		{ID: "older", ModelID: "glm-4.7-flash", Provider: "fixture", SourceID: "older-source", Capabilities: fixtureCaps(), Free: true, Available: true},
		{ID: "cross", ModelID: "minimax-3.1", Provider: "fixture", SourceID: "other-source", Capabilities: fixtureCaps(), Free: true, Available: true}}
}
func fixtureReq() Requirements {
	return Requirements{Task: Coding, Bytes: 100, Output: 100, Tools: true, Modalities: map[string]bool{"text": true}, Outputs: map[string]bool{"text": true}}
}
func TestDraftTaskEvidenceOutranksFamilyAndNames(t *testing.T) {
	s := fixtureCatalog(t)
	r := fixtureReq()
	r.Continuity = true
	p := Rank("glm-5.3-flash", r, fixtureRoutes(), s, Policy{AllowUnknown: true})
	if len(p.Candidates) != 2 || p.Candidates[0].ModelID != "minimax-3.1" || p.Candidates[0].Comparison.Band != "comparable" || p.Candidates[1].Comparison.WorstLoss < .29 {
		t.Fatal(p)
	}
}
func TestDraftMissingAndIncomparableEvidenceIsNotZero(t *testing.T) {
	s := fixtureCatalog(t)
	m := s.models["other/minimax-3.1"]
	m.Benchmarks[0].Harness = "different-harness"
	m.Benchmarks[1].Variant = "max-effort"
	s.models[m.ID] = m
	p := Rank("glm-5.3-flash", fixtureReq(), fixtureRoutes(), s, Policy{AllowUnknown: true})
	if len(p.Candidates) != 2 || p.Candidates[0].ModelID != "minimax-3.1" || p.Candidates[0].Comparison.Band != "unknown" || p.Candidates[0].Comparison.Matched != 0 {
		t.Fatal(p)
	}
	if got := Rank("glm-5.3-flash", fixtureReq(), fixtureRoutes(), s, Policy{RequireComparable: true}); len(got.Candidates) != 1 {
		t.Fatal(got)
	}
}
func TestDraftStrictLossBoundRejectsUnknownAndRegression(t *testing.T) {
	maximum := .05
	p := Rank("glm-5.3-flash", fixtureReq(), fixtureRoutes(), fixtureCatalog(t), Policy{AllowUnknown: true, MaxLoss: &maximum})
	if len(p.Candidates) != 1 || p.Candidates[0].ModelID != "minimax-3.1" {
		t.Fatal(p)
	}
	zero := 0.0
	if got := Rank("glm-5.3-flash", fixtureReq(), fixtureRoutes(), nil, Policy{AllowUnknown: true, MaxLoss: &zero}); len(got.Candidates) != 0 {
		t.Fatal(got)
	}
}
func TestDraftExternalPriceNeverGrantsFreeAdmission(t *testing.T) {
	routes := fixtureRoutes()
	routes[1].Free = false
	routes[2].Available = false
	if got := Rank("glm-5.3-flash", fixtureReq(), routes, fixtureCatalog(t), Policy{AllowUnknown: true}); len(got.Candidates) != 0 {
		t.Fatal(got)
	}
}
func TestDraftNoFuzzyIdentityOrCrossPublisherContinuity(t *testing.T) {
	s := fixtureCatalog(t)
	if _, ok := s.Resolve("unknown", "glm-source"); ok {
		t.Fatal("guessed provider identity")
	}
	if _, ok := s.Resolve("fixture", "glm-source:free"); ok {
		t.Fatal("guessed source alias")
	}
	s.models["other/minimax-3.1"] = Model{ID: "other/minimax-3.1", Family: "glm"}
	if s.Family("other/minimax-3.1") == s.Family("lab/glm-5.3-flash") {
		t.Fatal("cross-publisher family proof invented")
	}
}
func TestDraftDuplicateCredentialsCannotBoostQuality(t *testing.T) {
	r := fixtureRoutes()
	s := fixtureCatalog(t)
	before := Rank("glm-5.3-flash", fixtureReq(), r, s, Policy{AllowUnknown: true})
	for i := 0; i < 50; i++ {
		clone := r[1]
		clone.ID = "duplicate"
		r = append(r, clone)
	}
	after := Rank("glm-5.3-flash", fixtureReq(), r, s, Policy{AllowUnknown: true})
	if before.Candidates[0].ModelID != after.Candidates[0].ModelID || !reflect.DeepEqual(before.Candidates[1].Comparison, after.Candidates[1].Comparison) {
		t.Fatal(before, after)
	}
}
func TestDraftKnownSlowRouteCannotReturnInModelAllowlist(t *testing.T) {
	routes := fixtureRoutes()
	slow := routes[2]
	slow.ID = "slow"
	slow.LatencyP95 = time.Minute
	routes[2].LatencyP95 = time.Second
	routes = append(routes, slow)
	p := Rank("glm-5.3-flash", fixtureReq(), routes, fixtureCatalog(t), Policy{AllowUnknown: true, Deadline: 2 * time.Second})
	if len(p.Candidates) == 0 || !reflect.DeepEqual(p.Candidates[0].RouteIDs, []string{"cross"}) {
		t.Fatal(p)
	}
}
func TestDraftOpaqueStateAlwaysStopsCrossModel(t *testing.T) {
	req := fixtureReq()
	req.OpaqueState = true
	p := Rank("glm-5.3-flash", req, fixtureRoutes(), fixtureCatalog(t), Policy{AllowUnknown: true})
	if p.Refused == "" || len(p.Candidates) != 0 {
		t.Fatal(p)
	}
}
func TestDraftCapabilityHashChangesButOrderDoesNot(t *testing.T) {
	a := fixtureCaps()
	b := fixtureCaps()
	b.ReasoningLevels = []string{"high", "low"}
	if CapabilitiesHash(a) != CapabilitiesHash(b) {
		t.Fatal("order-only fingerprint changed")
	}
	b.Context = 1
	if CapabilitiesHash(a) == CapabilitiesHash(b) {
		t.Fatal("context revocation not fenced")
	}
	b = a
	b.Tools = false
	if CapabilitiesHash(a) == CapabilitiesHash(b) {
		t.Fatal("tool revocation not fenced")
	}
}
func TestDraftStoreRejectsBrokenRefreshAndDoesNotRejuvenateLocalCache(t *testing.T) {
	raw := []byte(`{"models":{"lab/model":{"id":"lab/model"}},"providers":{},"_evidence":{"retrieved_at":"2026-11-01T12:00:00Z"}}`)
	var s Store
	if err := s.PublishFrom("fixture", raw, fixtureNow); err != nil {
		t.Fatal(err)
	}
	before := s.current.Load()
	if err := s.PublishFrom("fixture", []byte(`{"data":[]}`), fixtureNow); err == nil {
		t.Fatal("wrong feed shape accepted")
	}
	if s.current.Load() != before {
		t.Fatal("failed refresh poisoned snapshot")
	}
	if s.SnapshotForSource("fixture", fixtureNow, time.Hour) != nil {
		t.Fatal("old data timestamp rejuvenated by reread")
	}
	if s.SnapshotForSource("other-source", fixtureNow, 72*time.Hour) != nil {
		t.Fatal("source-change reused unrelated snapshot")
	}
}
func TestDraftSnapshotConcurrency(t *testing.T) {
	raw := []byte(`{"models":{"lab/model":{"id":"lab/model"}},"providers":{}}`)
	var s Store
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 100; j++ {
				if err := s.Publish(raw, fixtureNow); err != nil {
					t.Error(err)
				}
				_ = s.Snapshot(fixtureNow, time.Hour).Count()
			}
		}()
	}
	wg.Wait()
}
func TestDraftMalformedLinksAndAmbiguousScoresFailClosed(t *testing.T) {
	for _, raw := range []string{`{"models":{}}`, `{"models":{"unqualified":{}}}`, `{"models":{"lab/a":{"id":"lab/b"}}}`, `{"models":{"lab/a":{}},"providers":{"p":{"models":{"x":{"canonical_model_id":"lab/missing"}}}}}`} {
		if _, err := DecodeModelsDev([]byte(raw), fixtureNow); err == nil {
			t.Fatal(raw)
		}
	}
	b := Benchmark{Name: "Terminal-Bench", Score: json.RawMessage(`90`), Metric: "Elo", Version: "1", Harness: "x", Variant: "plain", Source: "https://example.org"}
	if _, _, ok := normalizedBenchmark(b, Coding); ok {
		t.Fatal("Elo treated as accuracy")
	}
}
func TestDraftLiveRemovalAndMetadataChangeAffectNextPlan(t *testing.T) {
	routes := fixtureRoutes()
	s := fixtureCatalog(t)
	first := Rank("glm-5.3-flash", fixtureReq(), routes, s, Policy{AllowUnknown: true})
	routes[2].Available = false
	second := Rank("glm-5.3-flash", fixtureReq(), routes, s, Policy{AllowUnknown: true})
	if first.Candidates[0].ModelID == second.Candidates[0].ModelID {
		t.Fatal(first, second)
	}
	routes[2].Available = true
	routes[2].Capabilities.Tools = false
	third := Rank("glm-5.3-flash", fixtureReq(), routes, s, Policy{AllowUnknown: true})
	if len(third.Candidates) != 1 || third.Candidates[0].ModelID != "glm-4.7-flash" {
		t.Fatal(third)
	}
}

func TestDraftAmbiguousScoreUnitsAndDuplicateKeysStayUnknown(t *testing.T) {
	b := Benchmark{Name: "Terminal-Bench", Score: json.RawMessage(`0.95`), Metric: "pass@1", Version: "1", Harness: "fixture", Variant: "fixture", Source: "https://example.org"}
	if _, _, ok := normalizedBenchmark(b, Coding); ok {
		t.Fatal("ambiguous fraction/percentage score admitted")
	}
	if _, err := DecodeModelsDev([]byte(`{"models":{"lab/a":{},"lab/a":{"family":"other"}}}`), fixtureNow); err == nil {
		t.Fatal("duplicate identity silently overridden")
	}
}
func TestDraftKnownFailureDomainDiversityWithinEqualQuality(t *testing.T) {
	routes := fixtureRoutes()
	s := fixtureCatalog(t)
	// Quality metadata absent: no invented ranking, only compatibility and domain hints.
	routes[1].ModelID = "a"
	routes[1].SourceID = "unknown-a"
	routes[1].FailureDomain = "transport-a"
	routes[2].ModelID = "b"
	routes[2].SourceID = "unknown-b"
	routes[2].FailureDomain = "transport-a"
	third := routes[2]
	third.ModelID = "c"
	third.ID = "third"
	third.FailureDomain = "transport-b"
	routes = append(routes, third)
	p := Rank("glm-5.3-flash", fixtureReq(), routes, s, Policy{AllowUnknown: true, MaxModels: 2})
	if len(p.Candidates) != 2 || p.Candidates[0].ModelID != "a" || p.Candidates[1].ModelID != "c" {
		t.Fatal(p)
	}
}

func TestDraftNullScoreDoesNotBecomeZero(t *testing.T) {
	b := Benchmark{Name: "Terminal-Bench", Score: json.RawMessage(`null`), Metric: "pass@1", Version: "1", Harness: "fixture", Variant: "fixture", Source: "https://example.org"}
	if _, _, ok := normalizedBenchmark(b, Coding); ok {
		t.Fatal("missing score interpreted as zero")
	}
}
