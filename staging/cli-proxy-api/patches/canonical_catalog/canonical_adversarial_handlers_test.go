package handlers

import (
	"context"
	cfg "github.com/router-for-me/CLIProxyAPI/v8/internal/config"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/registry"
	auth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
	"testing"
)

func TestAdversarialReviewFreeSuffixAfterBaseRemoval(t *testing.T) {
	h, e := canonicalFixture(t, nil, false)
	a := &auth.Auth{ID: "review-paid-raw", Provider: e.Identifier(), Status: auth.StatusActive}
	if _, err := h.AuthManager.Register(context.Background(), a); err != nil {
		t.Fatal(err)
	}
	reg := registry.GetGlobalRegistry()
	defer reg.UnregisterClient(a.ID)
	reg.RegisterClient(a.ID, a.Provider, []*registry.ModelInfo{{ID: "removed-model:free", CanonicalID: "removed-model", CanonicalPolicy: "override", CanonicalFree: false, HideFromDiscovery: true}})
	_, _, err := h.ExecuteWithAuthManager(context.Background(), "openai", "removed-model:free", []byte(`{"model":"removed-model:free","messages":[{"role":"user","content":"test"}]}`), "")
	if len(e.calls) > 0 {
		t.Fatalf("free policy bypass: dispatched a non-free raw route after canonical base disappeared: calls=%v err=%v", e.calls, err)
	}
}
func TestAdversarialReviewGeminiDocumentFallback(t *testing.T) {
	r, err := canonicalRequestRequirements([]byte(`{"contents":[{"parts":[{"fileData":{"mimeType":"application/pdf","fileUri":"gs://fake-private-document"}}]}]}`))
	if err != nil {
		t.Fatal(err)
	}
	info := &registry.ModelInfo{CanonicalFree: true, ContextLength: 32768, MaxCompletionTokens: 4096, SupportedInputModalities: []string{"text"}, SupportedOutputModalities: []string{"text"}}
	if canonicalCompatible(info, r) {
		t.Fatalf("PDF admitted to text-only alternative; detected modalities=%v", r.Modalities)
	}
}
func TestAdversarialReviewRequestedAudioOutput(t *testing.T) {
	r, err := canonicalRequestRequirements([]byte(`{"messages":[{"role":"user","content":"say hello"}],"modalities":["text","audio"],"audio":{"voice":"alloy","format":"wav"}}`))
	if err != nil {
		t.Fatal(err)
	}
	info := &registry.ModelInfo{CanonicalFree: true, ContextLength: 32768, MaxCompletionTokens: 4096, SupportedInputModalities: []string{"text"}, SupportedOutputModalities: []string{"text"}}
	if canonicalCompatible(info, r) {
		t.Fatal("requested audio output admitted to text-only alternative")
	}
}

func TestCanonicalFreeSuffixRequiresPositiveOverrideProvenance(t *testing.T) {
	h, e := canonicalFixture(t, nil, false)
	a := &auth.Auth{ID: "review-qualified-paid", Provider: e.Identifier(), Status: auth.StatusActive}
	h.AuthManager.Register(context.Background(), a)
	r := registry.GetGlobalRegistry()
	defer r.UnregisterClient(a.ID)
	r.RegisterClient(a.ID, a.Provider, []*registry.ModelInfo{{ID: "unknown-publisher/removed:free", CanonicalID: "unknown-publisher/removed", CanonicalPolicy: "override", HideFromDiscovery: true}, {ID: "provider/removed:free", CanonicalID: "removed", CanonicalPolicy: "override", CanonicalOverride: true, HideFromDiscovery: true}})
	if _, _, err := h.ExecuteWithAuthManager(context.Background(), "openai", "unknown-publisher/removed:free", []byte(`{"model":"unknown-publisher/removed:free"}`), ""); err == nil || len(e.calls) != 0 {
		t.Fatal("a slash alone bypassed free policy", err, e.calls)
	}
	if _, _, err := h.ExecuteWithAuthManager(context.Background(), "openai", "provider/removed:free", []byte(`{"model":"provider/removed:free"}`), ""); err == nil || len(e.calls) != 0 {
		t.Fatal("provider override without free entitlement was dispatched", err, e.calls)
	}
}

func TestCanonicalDisabledKeepsNativeFreeSourceSyntax(t *testing.T) {
	h, e := canonicalFixture(t, nil, false)
	h.AuthManager.SetConfig(&cfg.Config{})
	a := &auth.Auth{ID: "review-stock-free", Provider: e.Identifier(), Status: auth.StatusActive}
	h.AuthManager.Register(context.Background(), a)
	r := registry.GetGlobalRegistry()
	defer r.UnregisterClient(a.ID)
	r.RegisterClient(a.ID, a.Provider, []*registry.ModelInfo{{ID: "stock-model:free"}})
	if _, _, err := h.ExecuteWithAuthManager(context.Background(), "openai", "stock-model:free", []byte(`{"model":"stock-model:free"}`), ""); err != nil || len(e.calls) != 1 {
		t.Fatal("opt-in disabled changed stock model execution", err, e.calls)
	}
}
