package auth

import (
	"github.com/router-for-me/CLIProxyAPI/v8/internal/registry"
	"testing"
	"time"
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

func TestCanonicalSelectorUsesExistingSourceCooldown(t *testing.T) {
	r := registry.GetGlobalRegistry()
	a := &Auth{ID: "canonical-held-source", Prefix: "orca", Provider: "openai-compatible-orcarouter", ModelStates: map[string]*ModelState{"z-ai/glm-5.3-flash": {Unavailable: true, NextRetryAfter: time.Now().Add(time.Hour)}}}
	defer r.UnregisterClient(a.ID)
	r.RegisterClient(a.ID, a.Provider, []*registry.ModelInfo{{ID: "glm-5.3-flash:paid", HideFromDiscovery: true, CanonicalID: "glm-5.3-flash", CanonicalPolicy: "paid", CanonicalSourceID: "z-ai/glm-5.3-flash"}})
	m := NewManager(nil, nil, nil)
	source := m.selectionModelForAuth(a, "glm-5.3-flash:paid")
	if source != "z-ai/glm-5.3-flash" {
		t.Fatal(source)
	}
	if blocked, _, _ := isAuthBlockedForModel(a, source, time.Now()); !blocked {
		t.Fatal("new selector bypassed existing upstream cooldown")
	}
}
