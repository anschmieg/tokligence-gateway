package handlers

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/router-for-me/CLIProxyAPI/v8/internal/catalogfallback"
	cfg "github.com/router-for-me/CLIProxyAPI/v8/internal/config"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/registry"
	auth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
)

func TestDraftNativeCoordinatorChoosesEvidenceBeforeFamily(t *testing.T) {
	h, e := canonicalFixture(t, map[string]int{"cf-kilo": 503, "cf-other": 503}, true)
	manager := h.AuthManager
	manager.SetConfig(&cfg.Config{RequestRetry: 4, MaxRetryCredentials: 8, Models: registry.CatalogSources{CanonicalOnly: true, CanonicalRouting: registry.CanonicalRoutingConfig{EvidenceCatalog: "fixture", EvidenceMaxAgeHours: 1}}})
	a := &auth.Auth{ID: "draft-cross", Provider: e.Identifier(), Status: auth.StatusActive}
	if _, err := manager.Register(context.Background(), a); err != nil {
		t.Fatal(err)
	}
	base := &registry.ModelInfo{ID: "minimax-3.1", CanonicalID: "minimax-3.1", CanonicalPolicy: "canonical", CanonicalFree: true, PluginCostTier: "free", OwnedBy: "minimax", ContextLength: 32768, MaxCompletionTokens: 4096, SupportedParameters: []string{"tools"}, SupportedInputModalities: []string{"text"}, SupportedOutputModalities: []string{"text"}}
	selector := *base
	selector.ID = "minimax-3.1:free"
	selector.CanonicalPolicy = "free"
	selector.HideFromDiscovery = true
	selector.CanonicalSourceID = "upstream-minimax"
	reg := registry.GetGlobalRegistry()
	reg.RegisterClient(a.ID, a.Provider, []*registry.ModelInfo{base, &selector})
	t.Cleanup(func() { reg.UnregisterClient(a.ID) })
	bench := func(score int) []any {
		return []any{map[string]any{"name": "Terminal-Bench", "score": score, "metric": "pass@1", "version": "fixture-v1", "harness": "fixture-agent", "variant": "fixture-default", "source": "https://example.org/results"}, map[string]any{"name": "DeepSWE", "score": score, "metric": "resolved", "version": "fixture-v1", "harness": "fixture-agent", "variant": "fixture-default", "source": "https://example.org/results"}}
	}
	models := map[string]any{"lab/glm53": map[string]any{"id": "lab/glm53", "family": "glm", "benchmarks": bench(90)}, "lab/glm47": map[string]any{"id": "lab/glm47", "family": "glm", "benchmarks": bench(60)}, "other/minimax": map[string]any{"id": "other/minimax", "family": "minimax", "benchmarks": bench(89)}}
	providers := map[string]any{}
	for provider, link := range map[string][2]string{"kilo": {"upstream-glm-5.3-flash", "lab/glm53"}, "orca": {"upstream-glm-5.3-flash", "lab/glm53"}, "zai": {"upstream-glm-4.7-flash", "lab/glm47"}, "minimax": {"upstream-minimax", "other/minimax"}} {
		providers[provider] = map[string]any{"models": map[string]any{link[0]: map[string]any{"canonical_model_id": link[1]}}}
	}
	b, _ := json.Marshal(map[string]any{"models": models, "providers": providers})
	if err := catalogfallback.DefaultStore.PublishFrom("fixture", b, time.Now()); err != nil {
		t.Fatal(err)
	}
	_, headers, err := h.ExecuteWithAuthManager(context.Background(), "openai", "glm-5.3-flash:free", []byte(`{"messages":[{"role":"assistant","tool_calls":[{"id":"call_fixture","function":{"name":"read_file","arguments":"{}"}}]},{"role":"tool","tool_call_id":"call_fixture","content":"ok"}],"max_tokens":20}`), "")
	if err != nil || len(e.calls) != 3 || !strings.HasPrefix(e.calls[2], "draft-cross/") || headers.Get("X-Gateway-Resolved-Model") != "minimax-3.1" {
		t.Fatal(err, e.calls, headers)
	}
}
func TestDraftNativeOpaqueFunctionSignatureNeverUsesAlternative(t *testing.T) {
	h, e := canonicalFixture(t, map[string]int{"cf-kilo": 503, "cf-other": 503}, true)
	_, _, err := h.ExecuteWithAuthManager(context.Background(), "openai", "glm-5.3-flash:free", []byte(`{"messages":[{"role":"assistant","tool_calls":[{"function":{"name":"x","extra_content":{"google":{"thought_signature":"fixture"}}}}]}]}`), "")
	if err == nil || len(e.calls) != 2 {
		t.Fatal(err, e.calls)
	}
	for _, c := range e.calls {
		if strings.HasPrefix(c, "cf-alt/") {
			t.Fatal("opaque signature escaped", e.calls)
		}
	}
}
func TestDraftNativeSchemaFieldDoesNotDisableFallback(t *testing.T) {
	r, err := canonicalRequestRequirements([]byte(`{"messages":[{"role":"user","content":"list files"}],"tools":[{"type":"function","function":{"parameters":{"properties":{"fileData":{"type":"string"}}}}}]}`))
	info := &registry.ModelInfo{CanonicalFree: true, PluginCostTier: "free", ContextLength: 32768, MaxCompletionTokens: 4096, SupportedParameters: []string{"tools"}, SupportedInputModalities: []string{"text"}, SupportedOutputModalities: []string{"text"}}
	if err != nil || r.Modalities["file"] || !canonicalCompatible(info, r) {
		t.Fatal(r, err)
	}
}

func TestDraftNativeCatalogUsesFinalSourceNotDecoratedMetadataKey(t *testing.T) {
	info := &registry.ModelInfo{CanonicalSourceID: "publisher/model", MetadataModelID: "operator-prefix/publisher/model"}
	if got := canonicalEvidenceSource(info); got != "publisher/model" {
		t.Fatal(got)
	}
	info.PluginSourceModelID = "plugin-bare-source"
	if got := canonicalEvidenceSource(info); got != "plugin-bare-source" {
		t.Fatal(got)
	}
	r, err := canonicalRequestRequirements([]byte(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	canonicalSuffixRequirements("model:free(high)", &r)
	lowOnly := &registry.ModelInfo{CanonicalFree: true, PluginCostTier: "free", ContextLength: 32768, MaxCompletionTokens: 4096, Thinking: &registry.ThinkingSupport{Levels: []string{"low"}}, SupportedInputModalities: []string{"text"}, SupportedOutputModalities: []string{"text"}}
	if r.ReasoningEffort != "high" || canonicalCompatible(lowOnly, r) {
		t.Fatal(r)
	}
}

func TestDraftPluginCatalogDecodesOnlyKnownVendorTransportWrapper(t *testing.T) {
	for _, tc := range []struct{ owner, source, want string }{
		{"kilo", "kilo/nvidia/nemotron-3.5-lightning:free", "nvidia/nemotron-3.5-lightning:free"},
		{"kilo", "kilo/glm-4.7-flash:free", "glm-4.7-flash:free"},
		{"kilo", "unknown/publisher/model", "unknown/publisher/model"},
		{"kilo", "publisher/model", "publisher/model"},
	} {
		got := canonicalEvidenceSource(&registry.ModelInfo{OwnedBy: tc.owner, PluginSourceModelID: tc.source})
		if got != tc.want {
			t.Fatalf("%q: got %q want %q", tc.source, got, tc.want)
		}
	}
}
