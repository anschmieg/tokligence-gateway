package handlers

import (
	"context"
	"reflect"
	"strings"
	"testing"

	"github.com/router-for-me/CLIProxyAPI/v8/internal/registry"
)

func similarityModel(id string) *registry.ModelInfo {
	return &registry.ModelInfo{ID: id, CanonicalID: id, CanonicalPolicy: "canonical", CanonicalFree: true, ContextLength: 32768, MaxCompletionTokens: 4096, SupportedInputModalities: []string{"text"}, SupportedOutputModalities: []string{"text"}, SupportedParameters: []string{"tools", "tool_choice", "response_format", "reasoning"}}
}
func registerSimilarity(t *testing.T, client string, model *registry.ModelInfo) {
	t.Helper()
	base := *model
	free := *model
	free.ID = model.ID + ":free"
	free.CanonicalPolicy = "free"
	free.HideFromDiscovery = true
	registry.GetGlobalRegistry().RegisterClient(client, "similarity-fixture", []*registry.ModelInfo{&base, &free})
	t.Cleanup(func() { registry.GetGlobalRegistry().UnregisterClient(client) })
}
func TestCanonicalSimilarityNumericVersionsAndNewModels(t *testing.T) {
	base := "similarity-10.2-code"
	registerSimilarity(t, "sim-base", similarityModel(base))
	for _, id := range []string{"similarity-9.9-code", "similarity-10.1-code", "similarity-2.0-code"} {
		registerSimilarity(t, id, similarityModel(id))
	}
	r, _ := canonicalRequestRequirements([]byte(`{"max_tokens":10}`))
	p := registry.CanonicalRoutingConfig{}
	got := canonicalRankedFallbacks(base, r, p)
	if len(got) != 3 || got[0] != "similarity-10.1-code" || got[1] != "similarity-9.9-code" {
		t.Fatal(got)
	}
	// Publication/removal changes ranking immediately; no name list or refresh job.
	registerSimilarity(t, "sim-new", similarityModel("similarity-10.2-code-preview"))
	if got = canonicalRankedFallbacks(base, r, p); len(got) == 0 || got[0] != "similarity-10.2-code-preview" {
		t.Fatal(got)
	}
	registry.GetGlobalRegistry().UnregisterClient("sim-new")
	if got = canonicalRankedFallbacks(base, r, p); got[0] != "similarity-10.1-code" {
		t.Fatal(got)
	}
}
func TestCanonicalSimilarityCrossFamilySpecializationAndContinuity(t *testing.T) {
	base := "simfamily-5-coder"
	registerSimilarity(t, "sim-base", similarityModel(base))
	registerSimilarity(t, "sim-general", similarityModel("simfamily-5-chat"))
	registerSimilarity(t, "sim-code", similarityModel("otherfamily-5-coder"))
	r, _ := canonicalRequestRequirements([]byte(`{"max_tokens":10}`))
	got := canonicalRankedFallbacks(base, r, registry.CanonicalRoutingConfig{})
	if len(got) != 2 || got[0] != "otherfamily-5-coder" {
		t.Fatal("portable new task should prefer the closer specialization", got)
	}
	r, _ = canonicalRequestRequirements([]byte(`{"messages":[{"role":"assistant","tool_calls":[{"id":"call_1","type":"function","function":{"name":"read_file","arguments":"{}"}}]},{"role":"tool","tool_call_id":"call_1","content":"ok"}],"max_tokens":10}`))
	got = canonicalRankedFallbacks(base, r, registry.CanonicalRoutingConfig{})
	if !r.Continuity || !r.Tools || got[0] != "simfamily-5-chat" || got[1] != "otherfamily-5-coder" {
		t.Fatal(r, got)
	}
	// If the family route cannot preserve the requested tool protocol, a compatible
	// different family remains eligible; never force an incompatible family.
	bad := similarityModel("simfamily-5-chat")
	bad.SupportedParameters = nil
	registerSimilarity(t, "sim-general", bad)
	got = canonicalRankedFallbacks(base, r, registry.CanonicalRoutingConfig{})
	if len(got) != 1 || got[0] != "otherfamily-5-coder" {
		t.Fatal(got)
	}
}
func TestCanonicalSimilarityOpaqueStateNeverSubstitutes(t *testing.T) {
	for _, body := range []string{
		`{"previous_response_id":"resp_fixture"}`,
		`{"conversation":{"id":"conv_fixture"}}`,
		`{"input":[{"type":"reasoning","encrypted_content":"fixture"}]}`,
		`{"input":[{"type":"reasoning","id":"rs_fixture","summary":[{"type":"summary_text","text":"summary"}]}]}`,
		`{"messages":[{"role":"assistant","reasoning_details":[{"type":"reasoning.encrypted","data":"fixture"}]}]}`,
		`{"input":[{"type":"item_reference","id":"item_fixture"}]}`,
		`{"messages":[{"role":"assistant","content":[{"type":"thinking","thinking":"text","signature":"fixture"}]}]}`,
		`{"messages":[{"role":"assistant","content":[{"type":"redacted_thinking","data":"fixture"}]}]}`,
		`{"contents":[{"role":"model","parts":[{"text":"text","thoughtSignature":"fixture"}]}]}`,
		`{"messages":[{"role":"assistant","tool_calls":[{"extra_content":{"google":{"thought_signature":"fixture"}}}]}]}`,
	} {
		t.Run(body, func(t *testing.T) {
			h, e := canonicalFixture(t, map[string]int{"cf-kilo": 503, "cf-other": 503}, true)
			r, err := canonicalRequestRequirements([]byte(body))
			if err != nil || !r.OpaqueState {
				t.Fatal(r, err)
			}
			if got := canonicalRankedFallbacks("glm-5.3-flash", r, registry.CanonicalRoutingConfig{}); len(got) != 0 {
				t.Fatal(got)
			}
			_, _, failure := h.ExecuteWithAuthManager(context.Background(), "openai", "glm-5.3-flash:free", []byte(body), "")
			if failure == nil || len(e.calls) != 2 {
				t.Fatal(failure, e.calls)
			}
			for _, call := range e.calls {
				if strings.HasPrefix(call, "cf-alt/") {
					t.Fatal("opaque state escaped", e.calls)
				}
			}
		})
	}
}
func TestCanonicalSimilarityHistoryRequirements(t *testing.T) {
	tests := []struct {
		body                         string
		tools, reasoning, continuity bool
	}{
		{`{"messages":[{"role":"assistant","reasoning_content":"portable reasoning","content":"answer"}]}`, false, true, true},
		{`{"messages":[{"role":"assistant","content":"one"},{"role":"user","content":"two"},{"role":"assistant","content":"three"}]}`, false, false, true},
		{`{"input":[{"type":"function_call_output","call_id":"x","output":"ok"}]}`, true, false, true},
		{`{"contents":[{"role":"user","parts":[{"functionResponse":{"name":"x","response":{"result":"ok"}}}]}]}`, true, false, true},
		{`{"messages":[{"role":"user","content":"signature encrypted_content previous_response_id"}],"tools":[{"type":"function","function":{"parameters":{"properties":{"signature":{"type":"string"}}}}}]}`, true, false, false},
	}
	for _, tt := range tests {
		r, err := canonicalRequestRequirements([]byte(tt.body))
		if err != nil || r.Tools != tt.tools || r.Reasoning != tt.reasoning || r.Continuity != tt.continuity || r.OpaqueState {
			t.Fatal(tt.body, r, err)
		}
	}
}
func TestCanonicalSimilarityCostCapabilityAndCredentialCount(t *testing.T) {
	base := "similarity-5"
	registerSimilarity(t, "sim-base", similarityModel(base))
	good := similarityModel("nearby-5")
	registerSimilarity(t, "sim-good", good)
	small := similarityModel("similarity-4")
	small.ContextLength = 10
	registerSimilarity(t, "sim-small", small)
	paid := similarityModel("similarity-5-mini")
	paid.CanonicalFree = false
	registerSimilarity(t, "sim-paid", paid)
	r, _ := canonicalRequestRequirements([]byte(`{"messages":[{"role":"user","content":"some input text"}],"max_tokens":10}`))
	p := registry.CanonicalRoutingConfig{FreeFallbacks: map[string][]string{"similarity": {"similarity-4", "similarity-5-mini"}}}
	before := canonicalFallbackRanking(base, r, p)
	if len(before) != 1 || before[0].ID != "nearby-5" {
		t.Fatal(before)
	}
	registerSimilarity(t, "sim-duplicate", good)
	if after := canonicalFallbackRanking(base, r, p); !reflect.DeepEqual(before, after) {
		t.Fatal(before, after)
	}
	revoked := *good
	revoked.CanonicalFree = false
	registerSimilarity(t, "sim-good", &revoked)
	registerSimilarity(t, "sim-duplicate", &revoked)
	if got := canonicalRankedFallbacks(base, r, p); len(got) != 0 {
		t.Fatal("repriced route still free", got)
	}
}
func TestCanonicalSimilarityMetadataDistanceAndStableTies(t *testing.T) {
	base := similarityModel("basefamily-5")
	close := similarityModel("otherfamily-1")
	far := similarityModel("thirdfamily-1")
	far.ContextLength = 1048576
	far.MaxCompletionTokens = 128
	r := canonicalRequirements{}
	a := canonicalScore(base.ID, base, close, r, nil)
	b := canonicalScore(base.ID, base, far, r, nil)
	if a.Score <= b.Score {
		t.Fatal(a, b)
	}
	// Unknown families have distinct identities, not one artificial default family.
	if canonicalFamily("novelone-3") == canonicalFamily("noveltwo-3") || canonicalFamily("qwen3-235b-a22b") != "qwen" {
		t.Fatal("family extraction")
	}
	if got := canonicalFeatures("glm-5-3-flash"); !reflect.DeepEqual(got.Version, []int{5, 3}) {
		t.Fatal(got)
	}
	if got := canonicalFeatures("gpt-oss-120b"); len(got.Version) != 0 || got.Size != 120 {
		t.Fatal(got)
	}
	registerSimilarity(t, "sim-base", base)
	for _, id := range []string{"zfamily-1", "afamily-1"} {
		registerSimilarity(t, id, similarityModel(id))
	}
	first := canonicalRankedFallbacks(base.ID, r, registry.CanonicalRoutingConfig{})
	if len(first) != 2 || first[0] != "afamily-1" {
		t.Fatal(first)
	}
	for i := 0; i < 20; i++ {
		if got := canonicalRankedFallbacks(base.ID, r, registry.CanonicalRoutingConfig{}); !reflect.DeepEqual(first, got) {
			t.Fatal(first, got)
		}
	}
}

func TestCanonicalSimilarityRejectsNonChatAndUnprovenCapabilities(t *testing.T) {
	r, _ := canonicalRequestRequirements([]byte(`{"tools":[{}],"response_format":{"type":"json_object"},"max_tokens":20}`))
	for _, kind := range []string{"embedding", "missing-tools", "small-output", "no-context", "wrong-method"} {
		m := similarityModel("other-embedding-5")
		switch kind {
		case "missing-tools":
			m = similarityModel("other-5")
			m.SupportedParameters = []string{"response_format"}
		case "small-output":
			m = similarityModel("other-5")
			m.MaxCompletionTokens = 10
		case "no-context":
			m = similarityModel("other-5")
			m.ContextLength = 0
		case "wrong-method":
			m = similarityModel("other-5")
			m.SupportedGenerationMethods = []string{"embedContent"}
		}
		if canonicalCompatible(m, r) {
			t.Fatal(kind)
		}
	}
	good := similarityModel("other-5")
	good.SupportedGenerationMethods = []string{"generateContent"}
	if !canonicalCompatible(good, r) {
		t.Fatal("declared chat candidate rejected")
	}
}

func TestCanonicalSimilarityAgentShortlistRetainsCrossFamilyRescue(t *testing.T) {
	base := "shortlist-5-coder"
	registerSimilarity(t, "sim-base", similarityModel(base))
	for _, id := range []string{"shortlist-4-coder", "shortlist-3-coder", "shortlist-2-coder", "rescue-5-coder"} {
		registerSimilarity(t, id, similarityModel(id))
	}
	r, _ := canonicalRequestRequirements([]byte(`{"messages":[{"role":"tool","tool_call_id":"x","content":"ok"}]}`))
	got := canonicalRankedFallbacks(base, r, registry.CanonicalRoutingConfig{})
	if len(got) != 3 || got[0] != "shortlist-4-coder" || got[1] != "shortlist-3-coder" || got[2] != "rescue-5-coder" {
		t.Fatal(got)
	}
	got = canonicalRankedFallbacks(base, r, registry.CanonicalRoutingConfig{MaxFallbackModels: 1})
	if len(got) != 1 || got[0] != "shortlist-4-coder" {
		t.Fatal(got)
	}
	registry.GetGlobalRegistry().SuspendClientModel("shortlist-4-coder", "shortlist-4-coder:free", "fixture-hold")
	got = canonicalRankedFallbacks(base, r, registry.CanonicalRoutingConfig{})
	for _, id := range got {
		if id == "shortlist-4-coder" {
			t.Fatal("suspended route admitted", got)
		}
	}
}
func TestCanonicalSimilarityDatesAreNotVersions(t *testing.T) {
	if got := canonicalFeatures("novel-2026-11-03"); len(got.Version) != 0 {
		t.Fatal(got)
	}
	if got := canonicalFeatures("claude-sonnet-5-5-20261102"); !reflect.DeepEqual(got.Version, []int{5, 5}) {
		t.Fatal(got)
	}
}
