package auth

import (
	"github.com/router-for-me/CLIProxyAPI/v8/internal/registry"
	"testing"
)

func TestCanonicalReverseMappingIsCredentialScopedAndKeepsOverrides(t *testing.T) {
	r := registry.GetGlobalRegistry()
	a := &Auth{ID: "canonical-auth-a", Prefix: "orca"}
	b := &Auth{ID: "canonical-auth-b"}
	defer r.UnregisterClient(a.ID)
	defer r.UnregisterClient(b.ID)
	r.RegisterClient(a.ID, "orca", []*registry.ModelInfo{{ID: "glm-5.3-flash", CanonicalID: "glm-5.3-flash", CanonicalSourceID: "orca/z-ai/glm-5.3-flash-free"}, {ID: "orca/z-ai/glm-5.3-flash-free", HideFromDiscovery: true}})
	r.RegisterClient(b.ID, "freehub", []*registry.ModelInfo{{ID: "glm-5.3-flash", CanonicalID: "glm-5.3-flash", CanonicalSourceID: "llm7-llm7/GLM-5.3-Flash"}, {ID: "llm7/GLM-5.3-Flash", HideFromDiscovery: true, CanonicalSourceID: "llm7-llm7/GLM-5.3-Flash"}})
	if got := rewriteModelForAuth("glm-5.3-flash", a); got != "z-ai/glm-5.3-flash-free" {
		t.Fatal(got)
	}
	if got := rewriteModelForAuth("glm-5.3-flash", b); got != "llm7-llm7/GLM-5.3-Flash" {
		t.Fatal(got)
	}
	if got := rewriteModelForAuth("llm7/GLM-5.3-Flash", b); got != "llm7-llm7/GLM-5.3-Flash" {
		t.Fatal(got)
	}
	if got := rewriteModelForAuth("orca/z-ai/glm-5.3-flash-free", a); got != "z-ai/glm-5.3-flash-free" {
		t.Fatal("legacy override lost", got)
	}
}
