package handlers

import (
	"context"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/catalogfallback"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/registry"
	coreauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/config"
	"strings"
	"testing"
)

func TestProfilePreferredUnscoredModelIsCuratedWithoutInventingBenchmarkProof(t *testing.T) {
	h, e := profileFixture(t, nil)
	a := &coreauth.Auth{ID: "quality-unscored", Provider: e.Identifier(), Status: coreauth.StatusActive}
	h.AuthManager.Register(context.Background(), a)
	info := &registry.ModelInfo{ID: "unscored-strong-model", CanonicalID: "unscored-strong-model", CanonicalPolicy: "canonical", CanonicalFree: true, PluginCostTier: "free", OwnedBy: "fixture-unmapped", ContextLength: 32000, MaxCompletionTokens: 4000, SupportedInputModalities: []string{"text"}, SupportedOutputModalities: []string{"text"}}
	selector := *info
	selector.ID = info.ID + ":free"
	selector.CanonicalPolicy = "free"
	selector.CanonicalSourceID = "source-unscored"
	selector.HideFromDiscovery = true
	registry.GetGlobalRegistry().RegisterClient(a.ID, a.Provider, []*registry.ModelInfo{info, &selector})
	t.Cleanup(func() { registry.GetGlobalRegistry().UnregisterClient(a.ID) })
	p := h.AuthManager.CanonicalRoutingPolicy()
	p.Profiles = map[string]registry.ModelProfile{"coding": {Task: catalogfallback.Coding, MaxModels: 2, PreferredModel: info.ID, CostPolicy: "session"}}
	h.AuthManager.SetConfig(&config.Config{Models: registry.CatalogSources{CanonicalOnly: true, CanonicalRouting: p}})
	body, status := h.ProfileModels("coding")
	rows := body["data"].([]map[string]any)
	if status != 200 || len(rows) != 2 || rows[0]["id"] != info.ID || rows[0]["profile_preferred"] != true || body["preferred_model"] != info.ID {
		t.Fatal(body, status)
	}
	if strings.Contains(rows[0]["selection_reason"].(string), "verified task evidence") {
		t.Fatal("unscored source got fake benchmark proof")
	}
	_, headers, err := h.ExecuteWithAuthManager(context.Background(), "openai", "coding", []byte(`{"model":"coding","messages":[{"role":"user","content":"code"}]}`), "")
	if err != nil || len(e.calls) != 1 || !strings.HasPrefix(e.calls[0], a.ID+"/") || headers.Get("X-Gateway-Resolved-Model") != info.ID {
		t.Fatal(err, e.calls, headers)
	}
	// A configured preference never lowers current capability requirements.
	info.ContextLength = 0
	selector.ContextLength = 0
	registry.GetGlobalRegistry().RegisterClient(a.ID, a.Provider, []*registry.ModelInfo{info, &selector})
	body, _ = h.ProfileModels("coding")
	for _, row := range body["data"].([]map[string]any) {
		if row["id"] == info.ID {
			t.Fatal("preference bypassed unknown context bound")
		}
	}
}
func TestProfileConfiguredDefaultDoesNotOverrideConcreteClientPreference(t *testing.T) {
	h, e := profileFixture(t, nil)
	p := h.AuthManager.CanonicalRoutingPolicy()
	p.Profiles = map[string]registry.ModelProfile{"coding": {Task: catalogfallback.Coding, MaxModels: 12, PreferredModel: "glm-4.7-flash", CostPolicy: "session"}}
	h.AuthManager.SetConfig(&config.Config{Models: registry.CatalogSources{CanonicalOnly: true, CanonicalRouting: p}})
	_, headers, err := h.ExecuteWithAuthManager(context.Background(), "openai", "coding", []byte(`{"model":"coding","messages":[{"role":"user","content":"code"}]}`), "")
	if err != nil || !strings.HasPrefix(e.calls[0], "cf-alt/") {
		t.Fatal(err, e.calls, headers)
	}
	_, headers, err = h.ExecuteWithAuthManager(registry.WithModelProfile(context.Background(), "coding"), "openai", "glm-5.3-flash", []byte(billingRaw), "")
	if err != nil || strings.HasPrefix(e.calls[1], "cf-alt/") || headers.Get("X-Gateway-Requested-Model") != "glm-5.3-flash" {
		t.Fatal(err, e.calls, headers)
	}
}
