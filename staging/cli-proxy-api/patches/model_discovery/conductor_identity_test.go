package auth

import (
	internalconfig "github.com/router-for-me/CLIProxyAPI/v8/internal/config"
	"testing"
)

func TestDiscoveryAliasUsesNativeReverseMapping(t *testing.T) {
	a := &Auth{Provider: "openai-compatible-fixture", Attributes: map[string]string{"api_key": "fake", "base_url": "https://fixture.invalid/v1", "compat_name": "fixture", "provider_key": "fixture"}}
	p := internalconfig.OpenAICompatibility{Name: "fixture", BaseURL: "https://fixture.invalid/v1", APIKeyEntries: []internalconfig.OpenAICompatibilityAPIKey{{APIKey: "fake"}}, ModelDiscovery: &internalconfig.ModelDiscoveryConfig{Enabled: true, FreeOnly: true, Aliases: []internalconfig.OpenAICompatibilityModel{{Name: "z-ai/glm-5.3-flash-free", Alias: "glm-5.3-flash"}}}}
	cfg := &internalconfig.Config{OpenAICompatibility: []internalconfig.OpenAICompatibility{p}}
	if actual := resolveUpstreamModelForOpenAICompatAPIKey(cfg, a, "glm-5.3-flash"); actual != "z-ai/glm-5.3-flash-free" {
		t.Fatal("dispatch reverse mapping", actual)
	}
	got := resolveAPIKeyModelAliasWithResult(cfg, a, "glm-5.3-flash")
	if got.UpstreamModel != "z-ai/glm-5.3-flash-free" {
		t.Fatal(got)
	}
	cfg.OpenAICompatibility[0].Models = []internalconfig.OpenAICompatibilityModel{{Name: "operator-model", Alias: "glm-5.3-flash"}}
	if got := resolveAPIKeyModelAliasWithResult(cfg, a, "glm-5.3-flash"); got.UpstreamModel != "operator-model" {
		t.Fatal(got)
	}
	cfg.OpenAICompatibility[0].Models = nil
	cfg.OpenAICompatibility[0].ModelDiscovery.Enabled = false
	if got := resolveAPIKeyModelAliasWithResult(cfg, a, "glm-5.3-flash"); got.UpstreamModel != "glm-5.3-flash" {
		t.Fatal(got)
	}
}
