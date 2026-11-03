package catalogfallback

import (
	"encoding/json"
	"testing"
)

func TestDraftIncompleteSettingsReduceConfidenceNotEraseEvidence(t *testing.T) {
	s := fixtureCatalog(t)
	full := compare(s, "lab/glm-5.3-flash", "other/minimax-3.1", Coding)
	m := s.models["other/minimax-3.1"]
	for i := range m.Benchmarks {
		m.Benchmarks[i].Harness = ""
		m.Benchmarks[i].Variant = ""
	}
	s.models[m.ID] = m
	partial := compare(s, "lab/glm-5.3-flash", m.ID, Coding)
	if partial.Matched != 2 || partial.Confidence <= 0 || partial.Confidence >= full.Confidence || partial.Band != "partial" {
		t.Fatal(full, partial)
	}
	if partial.RiskLoss <= full.RiskLoss {
		t.Fatal("uncertainty not penalized", full, partial)
	}
	p := Rank("glm-5.3-flash", fixtureReq(), fixtureRoutes(), s, Policy{AllowUnknown: true})
	if p.Candidates[0].ModelID != "minimax-3.1" {
		t.Fatal("useful incomplete high quality evidence discarded", p)
	}
}
func TestDraftSingleBenchmarkContributesAndDuplicatesCannotBoostConfidence(t *testing.T) {
	s := fixtureCatalog(t)
	m := s.models["other/minimax-3.1"]
	m.Benchmarks = m.Benchmarks[:1]
	s.models[m.ID] = m
	a := compare(s, "lab/glm-5.3-flash", m.ID, Coding)
	if a.Matched != 1 || a.Confidence <= 0 || a.Band != "partial" {
		t.Fatal(a)
	}
	for i := 0; i < 20; i++ {
		m.Benchmarks = append(m.Benchmarks, m.Benchmarks[0])
	}
	s.models[m.ID] = m
	b := compare(s, "lab/glm-5.3-flash", m.ID, Coding)
	if a != b {
		t.Fatal("repeated reports increased confidence", a, b)
	}
}
func TestDraftKnownSettingsConflictsRemainIncomparable(t *testing.T) {
	s := fixtureCatalog(t)
	m := s.models["other/minimax-3.1"]
	for i := range m.Benchmarks {
		m.Benchmarks[i].Version = "different-version"
	}
	s.models[m.ID] = m
	c := compare(s, "lab/glm-5.3-flash", m.ID, Coding)
	if c.Matched != 0 || c.Confidence != 0 {
		t.Fatal(c)
	}
}
func TestDraftStrongKnownRegressionCanRankBelowUnknown(t *testing.T) {
	s := fixtureCatalog(t)
	m := s.models["lab/glm-4.7-flash"]
	for i := range m.Benchmarks {
		m.Benchmarks[i].Score = json.RawMessage(`10`)
	}
	s.models[m.ID] = m
	m = s.models["other/minimax-3.1"]
	m.Benchmarks = nil
	s.models[m.ID] = m
	p := Rank("glm-5.3-flash", fixtureReq(), fixtureRoutes(), s, Policy{AllowUnknown: true})
	if p.Candidates[0].ModelID != "minimax-3.1" {
		t.Fatal("evidence existence treated as guaranteed superiority", p)
	}
}
