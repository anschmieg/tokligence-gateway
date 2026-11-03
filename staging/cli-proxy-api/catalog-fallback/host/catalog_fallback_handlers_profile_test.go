package handlers

import (
	"context"
	"encoding/json"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/catalogfallback"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/registry"
	coreauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/config"
	"strings"
	"testing"
	"time"
)

func profileFixture(t *testing.T, status map[string]int) (*BaseAPIHandler, *canonicalFakeExecutor) {
	return profileFixtureAt(t, status, time.Now())
}
func profileFixtureAt(t *testing.T, status map[string]int, at time.Time) (*BaseAPIHandler, *canonicalFakeExecutor) {
	t.Helper()
	h, e := canonicalFixture(t, status, true)
	cfg := &config.Config{Models: registry.CatalogSources{CanonicalOnly: true, CanonicalRouting: registry.CanonicalRoutingConfig{EvidenceCatalog: "profile-fixture", MaxAttempts: 8, MaxFallbackModels: 3}}}
	h.AuthManager.SetConfig(cfg)
	benchmark := func(score int) []any {
		return []any{map[string]any{"name": "Terminal-Bench", "score": score, "metric": "pass@1", "version": "2", "harness": "fixture", "variant": "standard", "source": "https://example.org/fixture"}, map[string]any{"name": "DeepSWE", "score": score, "metric": "resolved", "version": "1", "harness": "fixture", "variant": "standard", "source": "https://example.org/fixture"}}
	}
	data, _ := json.Marshal(map[string]any{"models": map[string]any{"lab/source": map[string]any{"benchmarks": benchmark(90)}, "lab/alt": map[string]any{"benchmarks": benchmark(80)}}, "providers": map[string]any{"kilo": map[string]any{"models": map[string]any{"upstream-glm-5.3-flash": map[string]any{"canonical_model_id": "lab/source"}}}, "orca": map[string]any{"models": map[string]any{"upstream-glm-5.3-flash": map[string]any{"canonical_model_id": "lab/source"}}}, "zai": map[string]any{"models": map[string]any{"upstream-glm-4.7-flash": map[string]any{"canonical_model_id": "lab/alt"}}}}})
	if err := catalogfallback.DefaultStore.PublishFrom("profile-fixture", data, at); err != nil {
		t.Fatal(err)
	}
	return h, e
}
func TestProfileNativeHintFallsBackWithoutPaidOrExtraOwner(t *testing.T) {
	h, e := profileFixture(t, map[string]int{"cf-kilo": 503, "cf-other": 503})
	ctx := registry.WithModelProfile(context.Background(), "coding")
	_, headers, err := h.ExecuteWithAuthManager(ctx, "openai", "glm-5.3-flash", []byte(`{"model":"glm-5.3-flash","messages":[{"role":"user","content":"code"}],"max_tokens":20}`), "")
	if err != nil || len(e.calls) != 3 || !strings.HasPrefix(e.calls[2], "cf-alt/") || headers.Get("X-Gateway-Profile") != "coding" || headers.Get("X-Gateway-Cost-Policy") != "SUB" {
		t.Fatal(err, e.calls, headers)
	}
	for _, call := range e.calls {
		if strings.HasPrefix(call, "cf-paid/") || strings.HasPrefix(call, "cf-or-paid/") {
			t.Fatal("profile charged", e.calls)
		}
	}
	if e.refresh != 0 {
		t.Fatal("second credential owner/refresh")
	}
}
func TestProfilePreferredModelPrecedesOtherModelCredentialPriority(t *testing.T) {
	h, e := profileFixture(t, nil)
	a, _ := h.AuthManager.GetByID("cf-alt")
	a.Attributes = map[string]string{"priority": "10"}
	if _, err := h.AuthManager.Update(context.Background(), a); err != nil {
		t.Fatal(err)
	}
	_, headers, err := h.ExecuteWithAuthManager(registry.WithModelProfile(context.Background(), "coding"), "openai", "glm-5.3-flash", []byte(`{"model":"glm-5.3-flash","messages":[{"role":"user","content":"code"}],"max_tokens":20}`), "")
	if err != nil || len(e.calls) != 1 || strings.HasPrefix(e.calls[0], "cf-alt/") || headers.Get("X-Gateway-Resolved-Model") != "glm-5.3-flash" {
		t.Fatal(err, e.calls, headers)
	}
}
func TestProfileNativeOpaqueHistoryCannotSwitchModels(t *testing.T) {
	h, e := profileFixture(t, map[string]int{"cf-kilo": 503, "cf-other": 503})
	_, _, err := h.ExecuteWithAuthManager(registry.WithModelProfile(context.Background(), "coding"), "openai", "glm-5.3-flash", []byte(`{"model":"glm-5.3-flash","messages":[{"role":"assistant","tool_calls":[{"function":{"name":"x","extra_content":{"google":{"thought_signature":"fixture"}}}}]}]}`), "")
	if err == nil || len(e.calls) != 2 {
		t.Fatal(err, e.calls)
	}
	for _, call := range e.calls {
		if strings.HasPrefix(call, "cf-alt/") {
			t.Fatal("opaque state moved", e.calls)
		}
	}
}
func TestProfilePickerAndExecutionShareEvidenceAndCost(t *testing.T) {
	h, _ := profileFixture(t, nil)
	body, status := h.ProfileModels("coding")
	if status != 200 {
		t.Fatal(body)
	}
	rows := body["data"].([]map[string]any)
	if len(rows) != 2 {
		t.Fatal(rows)
	}
	for _, row := range rows {
		if _, ok := row["free_only_id"]; ok {
			t.Fatal("redundant availability claim")
		}
		if row["model_role"] != "hint" {
			t.Fatal(row)
		}
	}
	registry.GetGlobalRegistry().UnregisterClient("cf-alt")
	body, _ = h.ProfileModels("coding")
	if len(body["data"].([]map[string]any)) != 1 {
		t.Fatal("withdrawn model remained in picker")
	}
}
func TestProfileNativeStreamPreservesProfileAndNoPostOutputFallback(t *testing.T) {
	h, e := profileFixture(t, nil)
	e.late = true
	data, headers, errs := h.ExecuteStreamWithAuthManager(registry.WithModelProfile(context.Background(), "coding"), "openai", "glm-5.3-flash", []byte(`{"model":"glm-5.3-flash","stream":true,"messages":[{"role":"user","content":"code"}],"max_tokens":20}`), "")
	if data == nil || headers.Get("X-Gateway-Profile") != "coding" {
		t.Fatal(headers)
	}
	for range data {
	}
	if errs != nil {
		for range errs {
		}
	}
	if len(e.calls) != 1 {
		t.Fatal("stream retried after output", e.calls)
	}
}
func TestProfileRequestBodyDuplicateValidationAtIngress(t *testing.T) {
	// Wrapper behavior is covered in the API package too; this keeps the request
	// type independent of protocol conversions and schema look-alike keys.
	if catalogfallback.ValidateProtocolJSON([]byte(`{"model":"a","model":"b"}`)) == nil {
		t.Fatal("ambiguous model accepted")
	}
	if _, err := canonicalRequestRequirements([]byte(`{"messages":[],"tools":[{"type":"function","function":{"parameters":{"properties":{"model":{"type":"string"}}}}}]}`)); err != nil {
		t.Fatal(err)
	}
}
func TestProfileRejectsUnknownFeatureCostsBeforeAnyDispatch(t *testing.T) {
	h, e := profileFixture(t, nil)
	for _, extra := range []string{`"tools":[{"type":"web_search"}]`, `"provider":{"allow_fallbacks":true}`, `"models":["paid-model"]`, `"service_tier":"priority"`} {
		raw := []byte(`{"model":"glm-5.3-flash","messages":[{"role":"user","content":"x"}],` + extra + `}`)
		_, _, err := h.ExecuteWithAuthManager(registry.WithModelProfile(context.Background(), "coding"), "openai", "glm-5.3-flash", raw, "")
		if err == nil || err.StatusCode != 400 || len(e.calls) != 0 {
			t.Fatal(extra, err, e.calls)
		}
	}
}

func TestProfileRetainsHistoricalCurationButNotStaleQualityAuthority(t *testing.T) {
	h, e := profileFixtureAt(t, nil, time.Now().Add(-8*24*time.Hour))
	body, status := h.ProfileModels("coding")
	if status != 200 || body["evidence_stale"] != true || len(body["data"].([]map[string]any)) == 0 {
		t.Fatal(body, status)
	}
	if catalogfallback.DefaultStore.SnapshotForSource("profile-fixture", time.Now(), 7*24*time.Hour) != nil {
		t.Fatal("stale source retained quality authority")
	}
	_, _, err := h.ExecuteWithAuthManager(registry.WithModelProfile(context.Background(), "coding"), "openai", "glm-5.3-flash", []byte(`{"model":"glm-5.3-flash","messages":[{"role":"user","content":"code"}],"max_tokens":20}`), "")
	if err != nil || len(e.calls) != 1 {
		t.Fatal("metadata outage broke currently eligible route", err, e.calls)
	}
}

func profileRankingFixture(t *testing.T, status map[string]int, scores map[string][2]int) (*BaseAPIHandler, *canonicalFakeExecutor) {
	t.Helper()
	h, e := profileFixture(t, status)
	type entry struct{ id, owner, model, source, record string }
	entries := []entry{{"cf-kilo", "kilo", "glm-5.3-flash", "upstream-glm-5.3-flash", "lab/source"}, {"cf-other", "orca", "glm-5.3-flash", "upstream-glm-5.3-flash", "lab/source"}, {"cf-paid", "paid", "glm-5.3-flash", "upstream-glm-5.3-flash", "lab/source"}, {"cf-or-paid", "openrouter", "glm-5.3-flash", "upstream-glm-5.3-flash", "lab/source"}, {"cf-alt", "zai", "glm-4.7-flash", "upstream-glm-4.7-flash", "lab/alt"}, {"cf-cross", "minimax", "minimax-3.1", "upstream-minimax", "lab/cross"}, {"cf-last", "qwen", "qwen3.8", "upstream-qwen", "lab/last"}}
	models := map[string]any{}
	providers := map[string]any{}
	for _, entry := range entries {
		pair, ok := scores[entry.record]
		if !ok {
			continue
		}
		benches := []any{}
		for i, name := range []string{"Terminal-Bench", "DeepSWE"} {
			benches = append(benches, map[string]any{"name": name, "score": pair[i], "metric": "pass@1", "version": "fixture", "harness": "fixture", "variant": "standard", "source": "https://example.org/fixture"})
		}
		models[entry.record] = map[string]any{"benchmarks": benches}
		providers[entry.owner] = map[string]any{"models": map[string]any{entry.source: map[string]any{"canonical_model_id": entry.record}}}
		if entry.id != "cf-cross" && entry.id != "cf-last" {
			continue
		}
		a := &coreauth.Auth{ID: entry.id, Provider: e.Identifier(), Status: coreauth.StatusActive, Attributes: map[string]string{"priority": "999"}}
		if _, err := h.AuthManager.Register(context.Background(), a); err != nil {
			t.Fatal(err)
		}
		base := &registry.ModelInfo{ID: entry.model, CanonicalID: entry.model, CanonicalPolicy: "canonical", CanonicalFree: true, PluginCostTier: "free", OwnedBy: entry.owner, ContextLength: 32768, MaxCompletionTokens: 4096, SupportedInputModalities: []string{"text"}, SupportedOutputModalities: []string{"text"}, SupportedParameters: []string{"tools"}}
		selector := *base
		selector.ID = entry.model + ":free"
		selector.CanonicalPolicy = "free"
		selector.CanonicalSourceID = entry.source
		selector.HideFromDiscovery = true
		registry.GetGlobalRegistry().RegisterClient(a.ID, a.Provider, []*registry.ModelInfo{base, &selector})
		id := a.ID
		t.Cleanup(func() { registry.GetGlobalRegistry().UnregisterClient(id) })
	}
	raw, _ := json.Marshal(map[string]any{"models": models, "providers": providers})
	if err := catalogfallback.DefaultStore.PublishFrom("profile-fixture", raw, time.Now()); err != nil {
		t.Fatal(err)
	}
	return h, e
}
func TestProfileFallbackUsesSimilarityNotCredentialPriority(t *testing.T) {
	h, e := profileRankingFixture(t, map[string]int{"cf-kilo": 503, "cf-other": 503}, map[string][2]int{"lab/source": {90, 80}, "lab/alt": {60, 55}, "lab/cross": {89, 79}})
	// Make the worse alternative still more preferred at credential level.
	a, _ := h.AuthManager.GetByID("cf-alt")
	a.Attributes = map[string]string{"priority": "10000"}
	_, _ = h.AuthManager.Update(context.Background(), a)
	_, headers, err := h.ExecuteWithAuthManager(registry.WithModelProfile(context.Background(), "coding"), "openai", "glm-5.3-flash", []byte(`{"model":"glm-5.3-flash","messages":[{"role":"user","content":"code"}],"max_tokens":20}`), "")
	if err != nil || len(e.calls) != 3 || !strings.HasPrefix(e.calls[2], "cf-cross/") || headers.Get("X-Gateway-Resolved-Model") != "minimax-3.1" {
		t.Fatal(err, e.calls, headers)
	}
}
func TestProfileUnavailablePreferenceStillAnchorsSimilarity(t *testing.T) {
	h, e := profileRankingFixture(t, nil, map[string][2]int{"lab/source": {90, 80}, "lab/alt": {60, 55}, "lab/cross": {89, 79}})
	registry.GetGlobalRegistry().UnregisterClient("cf-kilo")
	registry.GetGlobalRegistry().UnregisterClient("cf-other")
	_, headers, err := h.ExecuteWithAuthManager(registry.WithModelProfile(context.Background(), "coding"), "openai", "glm-5.3-flash", []byte(`{"model":"glm-5.3-flash","messages":[{"role":"user","content":"code"}],"max_tokens":20}`), "")
	if err != nil || len(e.calls) != 1 || !strings.HasPrefix(e.calls[0], "cf-cross/") || headers.Get("X-Gateway-Similarity-Anchor") != "glm-5.3-flash" {
		t.Fatal(err, e.calls, headers)
	}
}
func TestProfileFallbackChainNeverReanchorsToFailedAlternative(t *testing.T) {
	h, e := profileRankingFixture(t, map[string]int{"cf-kilo": 503, "cf-other": 503, "cf-alt": 503}, map[string][2]int{"lab/source": {90, 80}, "lab/alt": {90, 70}, "lab/cross": {80, 70}, "lab/last": {95, 66}})
	// Similarity to original chooses cross next; re-anchoring to alt would choose last.
	_, headers, err := h.ExecuteWithAuthManager(registry.WithModelProfile(context.Background(), "coding"), "openai", "glm-5.3-flash", []byte(`{"model":"glm-5.3-flash","messages":[{"role":"user","content":"code"}],"max_tokens":20}`), "")
	if err != nil || len(e.calls) != 4 || !strings.HasPrefix(e.calls[2], "cf-alt/") || !strings.HasPrefix(e.calls[3], "cf-cross/") || headers.Get("X-Gateway-Similarity-Anchor") != "glm-5.3-flash" {
		t.Fatal(err, e.calls, headers)
	}
}
func TestProfileExplicitPreferenceWorksWithoutExternalMetadata(t *testing.T) {
	h, e := profileFixture(t, nil)
	if err := catalogfallback.DefaultStore.PublishFrom("other-source", []byte(`{"models":{"lab/other":{}},"providers":{}}`), time.Now()); err != nil {
		t.Fatal(err)
	}
	rows, status := h.ProfileModels("coding")
	if status != 200 || len(rows["data"].([]map[string]any)) != 0 {
		t.Fatal(rows)
	}
	_, headers, err := h.ExecuteWithAuthManager(registry.WithModelProfile(context.Background(), "coding"), "openai", "glm-5.3-flash", []byte(`{"model":"glm-5.3-flash","messages":[{"role":"user","content":"code"}],"max_tokens":20}`), "")
	if err != nil || len(e.calls) != 1 || headers.Get("X-Gateway-Resolved-Model") != "glm-5.3-flash" {
		t.Fatal(err, e.calls, headers)
	}
}
func TestProfileNativeCredentialPriorityWithinPreferredModel(t *testing.T) {
	h, e := profileFixture(t, nil)
	a, _ := h.AuthManager.GetByID("cf-other")
	a.Attributes = map[string]string{"priority": "20"}
	_, _ = h.AuthManager.Update(context.Background(), a)
	_, _, err := h.ExecuteWithAuthManager(registry.WithModelProfile(context.Background(), "coding"), "openai", "glm-5.3-flash", []byte(`{"model":"glm-5.3-flash","messages":[{"role":"user","content":"code"}],"max_tokens":20}`), "")
	if err != nil || len(e.calls) != 1 || !strings.HasPrefix(e.calls[0], "cf-other/") {
		t.Fatal(err, e.calls)
	}
}
