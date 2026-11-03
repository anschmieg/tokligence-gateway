package auth

import (
	"context"
	cfg "github.com/router-for-me/CLIProxyAPI/v8/internal/config"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/registry"
	ex "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/executor"
	"testing"
)

func TestAdversarialReviewPinnedFreeSourceReAliasedToPaid(t *testing.T) {
	selector := "review-model:free"
	e := &openAICompatPoolExecutor{id: openAICompatPoolProviderKey}
	m := newOpenAICompatPoolTestManager(t, selector, []cfg.OpenAICompatibilityModel{{Name: "paid-upstream", Alias: "review-free-source"}}, e)
	id := "pool-auth-" + t.Name()
	registry.GetGlobalRegistry().RegisterClient(id, openAICompatPoolProviderKey, []*registry.ModelInfo{{ID: selector, CanonicalID: "review-model", CanonicalPolicy: "free", CanonicalFree: true, HideFromDiscovery: true, CanonicalSourceID: "review-free-source"}})
	_, err := m.Execute(context.Background(), []string{openAICompatPoolProviderKey}, ex.Request{Model: selector}, reviewPermit(id, selector))
	if err != nil {
		t.Fatal(err)
	}
	calls := e.ExecuteModels()
	if len(calls) != 1 || calls[0] != "review-free-source" {
		t.Fatalf("admitted free source reinterpreted as config alias: actual dispatch=%v", calls)
	}
}
func TestAdversarialReviewStreamingPoolPhysicalBudget(t *testing.T) {
	selector := "review-pool:free"
	e := &openAICompatPoolExecutor{id: openAICompatPoolProviderKey, streamFirstErrors: map[string]error{"pool-a": &Error{HTTPStatus: 503, Message: "fixture busy"}}}
	m := newOpenAICompatPoolTestManager(t, selector, []cfg.OpenAICompatibilityModel{{Name: "pool-a", Alias: "review-source"}, {Name: "pool-b", Alias: "review-source"}}, e)
	id := "pool-auth-" + t.Name()
	registry.GetGlobalRegistry().RegisterClient(id, openAICompatPoolProviderKey, []*registry.ModelInfo{{ID: selector, CanonicalID: "review-pool", CanonicalPolicy: "free", CanonicalFree: true, HideFromDiscovery: true, CanonicalSourceID: "review-source"}})
	result, err := m.ExecuteStream(context.Background(), []string{openAICompatPoolProviderKey}, ex.Request{Model: selector}, reviewPermit(id, selector))
	if err == nil {
		for range result.Chunks {
		}
	}
	if calls := e.StreamModels(); len(calls) > 1 {
		t.Fatalf("one canonical attempt dispatched %d upstream streams: %v", len(calls), calls)
	}
}

func reviewPermit(id, route string) ex.Options {
	info := registry.GetGlobalRegistry().CanonicalRouteInfos(route)[id]
	return ex.Options{Metadata: map[string]any{"gateway.canonical_dispatch": true, "gateway.canonical_route": route, "gateway.canonical_bindings": map[string]registry.CanonicalDispatchBinding{id: registry.NewCanonicalDispatchBinding(id, route, info)}, "gateway.canonical_permit": &registry.CanonicalDispatchPermit{}}}
}

func TestCanonicalFinalPermitRejectsMutationAndReplay(t *testing.T) {
	selector := "review-permit:free"
	e := &openAICompatPoolExecutor{id: openAICompatPoolProviderKey}
	m := newOpenAICompatPoolTestManager(t, selector, nil, e)
	id := "pool-auth-" + t.Name()
	r := registry.GetGlobalRegistry()
	info := &registry.ModelInfo{ID: selector, CanonicalID: "review-permit", CanonicalPolicy: "free", CanonicalFree: true, HideFromDiscovery: true, CanonicalSourceID: "final-source"}
	r.RegisterClient(id, openAICompatPoolProviderKey, []*registry.ModelInfo{info})
	opts := reviewPermit(id, selector)
	repriced := *info
	repriced.CanonicalFree = false
	r.RegisterClient(id, openAICompatPoolProviderKey, []*registry.ModelInfo{&repriced})
	if _, err := m.Execute(context.Background(), []string{openAICompatPoolProviderKey}, ex.Request{Model: selector}, opts); err == nil || len(e.ExecuteModels()) != 0 {
		t.Fatal("repriced target dispatched", err, e.ExecuteModels())
	}
	r.RegisterClient(id, openAICompatPoolProviderKey, []*registry.ModelInfo{info})
	opts = reviewPermit(id, selector)
	if _, err := m.Execute(context.Background(), []string{openAICompatPoolProviderKey}, ex.Request{Model: selector}, opts); err != nil {
		t.Fatal(err)
	}
	if _, err := m.Execute(context.Background(), []string{openAICompatPoolProviderKey}, ex.Request{Model: selector}, opts); err == nil || len(e.ExecuteModels()) != 1 {
		t.Fatal("permit reused", err, e.ExecuteModels())
	}
}

func TestCanonicalGuardBlocksStreamingPoolEvenIfCandidatePinIsBypassed(t *testing.T) {
	selector := "review-last-boundary:free"
	e := &openAICompatPoolExecutor{id: openAICompatPoolProviderKey, streamFirstErrors: map[string]error{"pool-a": &Error{HTTPStatus: 503, Message: "fixture busy"}}}
	m := newOpenAICompatPoolTestManager(t, selector, nil, e)
	a := m.List()[0]
	r := registry.GetGlobalRegistry()
	r.RegisterClient(a.ID, a.Provider, []*registry.ModelInfo{{ID: selector, CanonicalID: "review-last-boundary", CanonicalPolicy: "free", CanonicalFree: true, HideFromDiscovery: true, CanonicalSourceID: "pool-a"}})
	result, err := m.executeStreamWithModelPool(context.Background(), e, a, a.Provider, ex.Request{Model: selector}, reviewPermit(a.ID, selector), selector, "", []string{"pool-a", "pool-b"}, true, OAuthModelAliasResult{}, m.loadAPIKeyModelRouting(), true, false)
	if err == nil && result != nil {
		for range result.Chunks {
		}
	}
	calls := e.StreamModels()
	if len(calls) != 1 || calls[0] != "pool-a" {
		t.Fatal("last dispatch boundary escaped", calls, err)
	}
}
