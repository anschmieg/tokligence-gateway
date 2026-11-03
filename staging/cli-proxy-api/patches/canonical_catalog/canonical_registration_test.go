package cliproxy

import (
	internalconfig "github.com/router-for-me/CLIProxyAPI/v8/internal/config"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/registry"
	coreauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/config"
	"testing"
)

func TestCanonicalRegistrationIncludesEverySourceAndExplicitOverride(t *testing.T) {
	cfg := &config.Config{Models: registry.CatalogSources{CanonicalOnly: true}}
	s := &Service{}
	a := &coreauth.Auth{ID: "fixture", Provider: "freehub"}
	sources := []*ModelInfo{{ID: "llm7-llm7/GLM-5.3-Flash", OwnedBy: "llm7"}, {ID: "llm7-llm7/gpt-oss:20b", OwnedBy: "llm7"}}
	got := s.canonicalizeRegisteredModels(cfg, a, sources)
	byid := map[string]*ModelInfo{}
	for _, m := range got {
		byid[m.ID] = m
	}
	if byid["glm-5.3-flash"] == nil || byid["glm-5.3-flash"].HideFromDiscovery || byid["glm-5.3-flash"].CanonicalSourceID != sources[0].ID {
		t.Fatal(got)
	}
	if !byid[sources[0].ID].HideFromDiscovery || byid["llm7/GLM-5.3-Flash"].CanonicalSourceID != sources[0].ID {
		t.Fatal("explicit override lost", got)
	}
	if byid["gpt-oss-20b"] == nil {
		t.Fatal("unlisted new model not canonicalized")
	}
	if sources[0].HideFromDiscovery {
		t.Fatal("input mutated")
	}
	cfg.Models.CanonicalOnly = false
	if got := s.canonicalizeRegisteredModels(cfg, a, sources); len(got) != 2 || got[0] != sources[0] {
		t.Fatal("opt-in changed defaults")
	}
}
func TestCanonicalBuiltinProviderOverrideAndPaygoSeparation(t *testing.T) {
	cfg := &config.Config{Models: registry.CatalogSources{CanonicalOnly: true}, OpenAICompatibility: []config.OpenAICompatibility{{Name: "OrcaRouter", BaseURL: "https://api.orcarouter.ai/v1"}}}
	s := &Service{}
	builtin := s.canonicalizeRegisteredModels(cfg, &coreauth.Auth{ID: "gemini", Provider: "gemini"}, []*ModelInfo{{ID: "gemini-3.8-flash", OwnedBy: "google"}})
	found := false
	for _, m := range builtin {
		if m.ID == "gemini/gemini-3.8-flash" && m.HideFromDiscovery && m.CanonicalSourceID == "gemini-3.8-flash" {
			found = true
		}
	}
	if !found {
		t.Fatal(builtin)
	}
	a := &coreauth.Auth{ID: "orca", Provider: "openai-compatible-orcarouter", Prefix: "orca", Attributes: map[string]string{"compat_name": "OrcaRouter", "provider_key": "orcarouter"}}
	got := s.canonicalizeRegisteredModels(cfg, a, []*ModelInfo{{ID: "orca/openai/gpt-6-luna", MetadataModelID: "openai/gpt-6-luna", OwnedBy: "OrcaRouter"}})
	for _, m := range got {
		if !m.HideFromDiscovery && m.ID != "gpt-6-luna" {
			t.Fatal("unknown pricing exposed as included", m)
		}
	}
}

func TestCanonicalCatalogPriceAndRemovalReconcile(t *testing.T) {
	p := config.OpenAICompatibility{Name: "OrcaRouter", BaseURL: "https://api.orcarouter.ai/v1", ModelDiscovery: &internalconfig.ModelDiscoveryConfig{Enabled: true, FreeOnly: true}}
	cfg := &config.Config{Models: registry.CatalogSources{CanonicalOnly: true}, OpenAICompatibility: []config.OpenAICompatibility{p}}
	a := &coreauth.Auth{ID: "orca-price", Provider: "openai-compatible-orcarouter", Prefix: "orca", Attributes: map[string]string{"compat_name": "OrcaRouter", "provider_key": "orcarouter"}}
	source := []*ModelInfo{{ID: "orca/z-ai/glm-5.3-flash-free", MetadataModelID: "z-ai/glm-5.3-flash-free", OwnedBy: "OrcaRouter"}}
	s := &Service{}
	for _, tc := range []struct{ body, want string }{
		{`{"data":[{"id":"z-ai/glm-5.3-flash-free","pricing":{"request":"0"}}]}`, "glm-5.3-flash"},
		{`{"data":[{"id":"z-ai/glm-5.3-flash-free","pricing":{"request":"1"}}]}`, "glm-5.3-flash"},
		{`{"data":[]}`, ""},
		{`{"data":[{"id":"z-ai/glm-5.3-flash-free","pricing":{"request":"0"}}]}`, "glm-5.3-flash"},
	} {
		snap, err := parseDiscoveryCatalog([]byte(tc.body), "OrcaRouter", "api.orcarouter.ai", true)
		if err != nil {
			t.Fatal(err)
		}
		s.catalogDiscovery.snapshots = map[string]discoverySnapshot{discoveryKey(&p): snap}
		got := s.canonicalizeRegisteredModels(cfg, a, source)
		visible := []string{}
		preserved := false
		for _, m := range got {
			if !m.HideFromDiscovery {
				visible = append(visible, m.ID)
			}
			if m.ID == source[0].ID {
				preserved = true
			}
		}
		if !preserved {
			t.Fatal("override lost")
		}
		if tc.want == "" && len(visible) != 0 {
			t.Fatal("removed source still visible", visible)
		}
		if tc.want != "" && (len(visible) != 1 || visible[0] != tc.want) {
			t.Fatal(tc.body, visible)
		}
	}
}

func TestCanonicalCompatibleAliasUsesStableUpstreamCooldownIdentity(t *testing.T) {
	cfg := &config.Config{Models: registry.CatalogSources{CanonicalOnly: true}, OpenAICompatibility: []config.OpenAICompatibility{{Name: "OrcaRouter", BaseURL: "https://api.orcarouter.ai/v1"}}}
	s := &Service{}
	a := &coreauth.Auth{ID: "canonical-cooldown", Provider: "openai-compatible-orcarouter", Prefix: "orca", Attributes: map[string]string{"compat_name": "OrcaRouter", "provider_key": "orcarouter"}}
	source := []*ModelInfo{{ID: "orca/operator-alias", MetadataModelID: "z-ai/glm-5.3-flash", OwnedBy: "OrcaRouter"}}
	for _, m := range s.canonicalizeRegisteredModels(cfg, a, source) {
		if m.CanonicalPolicy == "canonical" || m.CanonicalPolicy == "paid" {
			if m.CanonicalSourceID != "z-ai/glm-5.3-flash" {
				t.Fatal("operator alias would split native source cooldown", m)
			}
		}
	}
}

func TestCanonicalPluginDisplayAliasDoesNotSplitSourceCooldown(t *testing.T) {
	cfg := &config.Config{Models: registry.CatalogSources{CanonicalOnly: true}}
	s := &Service{}
	a := &coreauth.Auth{ID: "canonical-plugin-cooldown", Provider: "freehub"}
	for _, m := range s.canonicalizeRegisteredModels(cfg, a, []*ModelInfo{{ID: "glm-5.3-flash", OwnedBy: "llm7"}, {ID: "llm7-llm7/GLM-5.3-Flash", OwnedBy: "llm7"}}) {
		if m.CanonicalPolicy == "canonical" || m.CanonicalPolicy == "free" {
			if m.CanonicalSourceID != "llm7-llm7/GLM-5.3-Flash" {
				t.Fatal(m)
			}
		}
	}
}
