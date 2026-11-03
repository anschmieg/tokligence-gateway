package cliproxy

import (
	internalconfig "github.com/router-for-me/CLIProxyAPI/v8/internal/config"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/registry"
	auth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/config"
	"testing"
)

func TestAdversarialReviewFreeHubPaidOpenRouterClassifiedFree(t *testing.T) {
	s := &Service{}
	c := &config.Config{Models: registry.CatalogSources{CanonicalOnly: true}}
	out := s.canonicalizeRegisteredModels(c, &auth.Auth{ID: "review-fh", Provider: "freehub"}, []*ModelInfo{{ID: "openrouter-openrouter/anthropic/claude-paid-review", OwnedBy: "openrouter", Description: "Paid route explicitly enabled with openrouter_paid_models"}})
	for _, m := range out {
		if m.CanonicalPolicy == "free" {
			t.Fatalf("paid OpenRouter publication automatically has free selector %q -> %q", m.ID, m.CanonicalSourceID)
		}
	}
}

func TestAdversarialReviewRegistrationToNativeAliasPaidDispatch(t *testing.T) {
	p := config.OpenAICompatibility{Name: "review", BaseURL: "https://review.invalid/v1", ModelDiscovery: &internalconfig.ModelDiscoveryConfig{Enabled: true, FreeOnly: true}, Models: []config.OpenAICompatibilityModel{{Name: "free-source", Alias: "free-display"}, {Name: "paid-source", Alias: "free-source"}}}
	c := &config.Config{Models: registry.CatalogSources{CanonicalOnly: true}, OpenAICompatibility: []config.OpenAICompatibility{p}}
	a := &auth.Auth{ID: "review-full-chain", Provider: "openai-compatible-review", Status: auth.StatusActive, Attributes: map[string]string{"api_key": "fake-review-key", "compat_name": "review", "provider_key": "openai-compatible-review"}}
	s := &Service{}
	snap, err := parseDiscoveryCatalog([]byte(`{"data":[{"id":"free-source","pricing":{"prompt":"0","completion":"0"}},{"id":"paid-source","pricing":{"prompt":"1","completion":"1"}}]}`), "review", "review.invalid", true)
	if err != nil {
		t.Fatal(err)
	}
	s.catalogDiscovery.snapshots = map[string]discoverySnapshot{discoveryKey(&p): snap}
	models := s.discoveredCompatModels(&p, buildOpenAICompatibilityConfigModels(&p))
	models = s.canonicalizeRegisteredModels(c, a, models)
	r := registry.GetGlobalRegistry()
	r.RegisterClient(a.ID, a.Provider, models)
	defer r.UnregisterClient(a.ID)
	free := r.CanonicalRouteInfos("free-source:free")[a.ID]
	if free == nil || !free.CanonicalFree {
		t.Fatal("fixture did not produce free source selector")
	}
	m := auth.NewManager(nil, nil, nil)
	m.SetConfig(c)
	if actual := m.ResolveExecutionModel(a, "free-source:free"); actual != "free-source" {
		t.Fatalf("real config/catalog/registration admitted source free-source; native resolution changes it to %q", actual)
	}
}
