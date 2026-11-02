package cliproxy

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	internalconfig "github.com/router-for-me/CLIProxyAPI/v8/internal/config"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/registry"
	coreauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/config"
)

func discoveryFixture() *config.OpenAICompatibility {
	return &config.OpenAICompatibility{Name: "fixture", BaseURL: "https://fixture.invalid/v1", ModelDiscovery: &internalconfig.ModelDiscoveryConfig{Enabled: true, FreeOnly: true, RefreshSeconds: 900}}
}
func TestCatalogAutoPriceAdmission(t *testing.T) {
	cases := []struct {
		body, host string
		want       bool
	}{
		{`{"id":"x","pricing":{"prompt":"0","completion":"0"}}`, "any.invalid", true},
		{`{"id":"x","pricing":{"request":"0"}}`, "any.invalid", true},
		{`{"id":"x","pricing":[{"input_price":0,"output_price":0}]}`, "any.invalid", true},
		{`{"id":"x","pricing":[{"input_price":0,"output_price":0},{"input_price":1,"output_price":0}]}`, "any.invalid", false},
		{`{"id":"x","pricing":{"request":"0","prompt":"1","completion":"0"}}`, "any.invalid", false},
		{`{"id":"x","pricing":{"prompt":"0"}}`, "any.invalid", false},
		{`{"id":"x","input_price":0,"output_price":0}`, "any.invalid", true},
		{`{"id":"x:free"}`, "api.unorouter.com", true},
		{`{"id":"x:free"}`, "unknown.invalid", false},
		{`{"id":"x-free"}`, "api.orcarouter.ai", false},
		{`{"id":"x:free","pricing":{"prompt":"1","completion":"0"}}`, "api.unorouter.com", false},
	}
	for _, c := range cases {
		var row map[string]any
		d := json.NewDecoder(strings.NewReader(c.body))
		d.UseNumber()
		if err := d.Decode(&row); err != nil {
			t.Fatal(err)
		}
		if got := freeCatalogEntry(row, c.host); got != c.want {
			t.Fatalf("%s got%v", c.body, got)
		}
	}
}
func TestCatalogAutoPreservesMetadataAndRejectsUnknownPrices(t *testing.T) {
	raw := []byte(`{"data":[{"id":"free","pricing":{"request":"0"},"context_window":4096,"max_output_tokens":256,"supports_vision":true,"supports_tool_calling":true},{"id":"paid","pricing":{"request":"1"}},{"id":"unknown"}]}`)
	got, err := parseDiscoveryCatalog(raw, "owner", "fixture.invalid", true)
	if err != nil {
		t.Fatal(err)
	}
	if len(got.models) != 1 || got.models[0].ID != "free" || len(got.details) != 3 {
		t.Fatal(got)
	}
	m := got.models[0]
	if m.ContextLength != 4096 || m.MaxCompletionTokens != 256 || len(m.SupportedParameters) != 2 || m.Thinking != nil || len(m.SupportedInputModalities) != 2 {
		t.Fatal(m)
	}
	if got.details["unknown"].ContextLength != 0 {
		t.Fatal("invented context")
	}
	for _, raw := range []string{`{"error":"failed"}`, `{"data":null}`, `garbage`} {
		if _, err := parseDiscoveryCatalog([]byte(raw), "x", "x", true); err == nil {
			t.Fatal("accepted malformed", raw)
		}
	}
}
func TestCatalogAutoKeepsAliasesAndManualOverrides(t *testing.T) {
	p := discoveryFixture()
	s := &Service{}
	snapshot, err := parseDiscoveryCatalog([]byte(`{"data":[{"id":"upstream","context_length":4096,"pricing":{"request":"0"}},{"id":"new","pricing":{"request":"0"}}]}`), "fixture", "fixture.invalid", true)
	if err != nil {
		t.Fatal(err)
	}
	s.catalogDiscovery.snapshots = map[string]discoverySnapshot{discoveryKey(p): snapshot}
	manual := []*ModelInfo{{ID: "old-alias", MetadataModelID: "upstream", Thinking: &registry.ThinkingSupport{Levels: []string{"ultra"}}}}
	got := s.discoveredCompatModels(p, manual)
	if len(got) != 2 || got[0].ID != "old-alias" || got[1].ID != "new" || got[0].Thinking != nil || got[0].ContextLength != 4096 {
		t.Fatal(got)
	}
	if manual[0].Thinking == nil {
		t.Fatal("input mutated")
	}
	// A subsequent authoritative catalog withdraws the formerly auto-added ID.
	replacement, _ := parseDiscoveryCatalog([]byte(`{"data":[{"id":"upstream","pricing":{"request":"0"}},{"id":"new","pricing":{"request":"1"}}]}`), "fixture", "fixture.invalid", true)
	s.catalogDiscovery.snapshots[discoveryKey(p)] = replacement
	got = s.discoveredCompatModels(p, manual)
	if len(got) != 1 || got[0].ID != "old-alias" {
		t.Fatal(got)
	}
}
func TestCatalogAutoHTTPIsBoundedGETAndDoesNotFollowRedirect(t *testing.T) {
	var gets, posts, target atomic.Int32
	destination := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { target.Add(1) }))
	defer destination.Close()
	redirect := false
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "POST" {
			posts.Add(1)
		}
		gets.Add(1)
		if r.URL.Path != "/v1/models" || r.Header.Get("Authorization") != "Bearer fixture-key" {
			t.Error("wrong metadata request")
		}
		if redirect {
			http.Redirect(w, r, destination.URL, http.StatusTemporaryRedirect)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"data":[{"id":"new","pricing":{"request":"0"}}]}`))
	}))
	defer server.Close()
	previous := discoveryHTTPClient
	discoveryHTTPClient = func(context.Context, *config.Config, *coreauth.Auth, time.Duration) *http.Client {
		return server.Client()
	}
	defer func() { discoveryHTTPClient = previous }()
	p := discoveryFixture()
	p.BaseURL = server.URL + "/v1"
	auth := &coreauth.Auth{Attributes: map[string]string{"api_key": "fixture-key"}}
	got, err := fetchDiscoveryCatalog(context.Background(), &config.Config{}, p, auth)
	if err != nil || len(got.models) != 1 {
		t.Fatal(got, err)
	}
	redirect = true
	if _, err := fetchDiscoveryCatalog(context.Background(), &config.Config{}, p, auth); err == nil {
		t.Fatal("redirect accepted")
	}
	if gets.Load() != 2 || posts.Load() != 0 || target.Load() != 0 {
		t.Fatal("unexpected physical requests")
	}
}
func TestCatalogAutoPublicationPreservesCooldown(t *testing.T) {
	r := registry.GetGlobalRegistry()
	id := "catalog-preserved-client"
	old := "catalog-preserved-old"
	next := "catalog-preserved-new"
	r.RegisterClient(id, "fixture", []*ModelInfo{{ID: old}})
	defer r.UnregisterClient(id)
	r.SetModelQuotaExceeded(id, old)
	auth := &coreauth.Auth{ID: id, Provider: "fixture", Attributes: map[string]string{"api_key": "fake"}}
	fence := newModelRegistrationFence(auth, nil)
	fence.preserveAvailability = true
	if !fence.publishModels(nil, id, "fixture", []*ModelInfo{{ID: old}, {ID: next}}) {
		t.Fatal("publication failed")
	}
	if !r.IsModelQuotaExceededForClient(id, old) {
		t.Fatal("catalog refresh cleared cooldown")
	}
	if fence.publishModels(nil, id, "fixture", []*ModelInfo{{ID: old}}) {
		t.Fatal("stale epoch accepted")
	}
}

func TestCatalogAutoPeriodicPassAddsAndWithdrawsWithoutConfigWrites(t *testing.T) {
	var generation, gets atomic.Int32
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gets.Add(1)
		if r.Method != "GET" {
			t.Error("inference sent by catalog worker")
		}
		if generation.Load() == 0 {
			w.Write([]byte(`{"data":[{"id":"new-a","pricing":{"request":"0"}}]}`))
		} else {
			w.Write([]byte(`{"data":[{"id":"new-a","pricing":{"request":"1"}},{"id":"new-b","pricing":{"request":"0"}}]}`))
		}
	}))
	defer server.Close()
	oldClient := discoveryHTTPClient
	discoveryHTTPClient = func(context.Context, *config.Config, *coreauth.Auth, time.Duration) *http.Client {
		return server.Client()
	}
	defer func() { discoveryHTTPClient = oldClient }()
	p := discoveryFixture()
	p.BaseURL = server.URL + "/v1"
	p.Models = []config.OpenAICompatibilityModel{{Name: "manual-source", Alias: "manual-alias"}}
	cfg := &config.Config{OpenAICompatibility: []config.OpenAICompatibility{*p}}
	manager := coreauth.NewManager(nil, &coreauth.RoundRobinSelector{}, nil)
	manager.SetConfig(cfg)
	auth, err := manager.Register(context.Background(), &coreauth.Auth{ID: "discovery-periodic-auth", Provider: "openai-compatible-fixture", Attributes: map[string]string{"api_key": "fake", "base_url": p.BaseURL, "compat_name": "fixture", "provider_key": "fixture"}})
	if err != nil {
		t.Fatal(err)
	}
	s := &Service{cfg: cfg, coreManager: manager}
	defer registry.GetGlobalRegistry().UnregisterClient(auth.ID)
	before, _ := json.Marshal(cfg)
	now := time.Now()
	s.catalogDiscoveryPass(context.Background(), now)
	has := func(id string) bool {
		for _, m := range registry.GetGlobalRegistry().GetModelsForClient(auth.ID) {
			if m.ID == id {
				return true
			}
		}
		return false
	}
	if !has("new-a") || !has("manual-alias") {
		t.Fatal("first pass not published")
	}
	s.catalogDiscoveryPass(context.Background(), now.Add(time.Second))
	if gets.Load() != 1 {
		t.Fatal("catalog polled before interval")
	}
	generation.Store(1)
	s.catalogDiscoveryPass(context.Background(), now.Add(901*time.Second))
	if has("new-a") || !has("new-b") || !has("manual-alias") || gets.Load() != 2 {
		t.Fatal("second pass did not reconcile free catalog")
	}
	after, _ := json.Marshal(cfg)
	if string(before) != string(after) {
		t.Fatal("worker rewrote provider configuration")
	}
}
