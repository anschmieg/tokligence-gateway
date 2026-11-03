package handlers

import (
	"context"
	"errors"
	"net/http"
	"reflect"
	"sync"
	"testing"

	cfg "github.com/router-for-me/CLIProxyAPI/v8/internal/config"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/registry"
	auth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
	ex "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/executor"
	sdkconfig "github.com/router-for-me/CLIProxyAPI/v8/sdk/config"
)

type canonicalFakeExecutor struct {
	mu       sync.Mutex
	calls    []string
	statuses map[string]int
	late     bool
	refresh  int
}

func (e *canonicalFakeExecutor) Identifier() string { return "canonical-fixture" }
func (e *canonicalFakeExecutor) record(a *auth.Auth, r ex.Request) int {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.calls = append(e.calls, a.ID+"/"+r.Model)
	return e.statuses[a.ID]
}
func (e *canonicalFakeExecutor) Execute(ctx context.Context, a *auth.Auth, r ex.Request, o ex.Options) (ex.Response, error) {
	status := e.record(a, r)
	if status > 0 {
		return ex.Response{}, &auth.Error{HTTPStatus: status, Message: "fixture rejection"}
	}
	return ex.Response{Payload: []byte(`{"model":"` + r.Model + `","choices":[{"message":{"content":"ok"}}]}`)}, nil
}
func (e *canonicalFakeExecutor) ExecuteStream(ctx context.Context, a *auth.Auth, r ex.Request, o ex.Options) (*ex.StreamResult, error) {
	status := e.record(a, r)
	if status > 0 {
		return nil, &auth.Error{HTTPStatus: status, Message: "fixture rejection"}
	}
	ch := make(chan ex.StreamChunk, 2)
	ch <- ex.StreamChunk{Payload: []byte(`data: {"choices":[{"delta":{"content":"ok"}}]}` + "\n\n")}
	if e.late {
		ch <- ex.StreamChunk{Err: errors.New("late failure")}
	}
	close(ch)
	return &ex.StreamResult{Chunks: ch}, nil
}
func (e *canonicalFakeExecutor) Refresh(ctx context.Context, a *auth.Auth) (*auth.Auth, error) {
	e.refresh++
	return a, nil
}
func (e *canonicalFakeExecutor) CountTokens(context.Context, *auth.Auth, ex.Request, ex.Options) (ex.Response, error) {
	return ex.Response{}, errors.New("unsupported")
}
func (e *canonicalFakeExecutor) HttpRequest(context.Context, *auth.Auth, *http.Request) (*http.Response, error) {
	return nil, errors.New("unsupported")
}
func canonicalFixture(t *testing.T, status map[string]int, alt bool) (*BaseAPIHandler, *canonicalFakeExecutor) {
	t.Helper()
	manager := auth.NewManager(nil, &auth.RoundRobinSelector{}, nil)
	e := &canonicalFakeExecutor{statuses: status}
	manager.RegisterExecutor(e)
	manager.SetConfig(&cfg.Config{RequestRetry: 4, MaxRetryCredentials: 8, Models: registry.CatalogSources{CanonicalOnly: true, CanonicalRouting: registry.CanonicalRoutingConfig{MaxAttempts: 8}}})
	type route struct{ id, owner, policy, base string }
	routes := []route{{"cf-kilo", "kilo", "free", "glm-5.3-flash"}, {"cf-other", "orca", "free", "glm-5.3-flash"}, {"cf-paid", "paid", "paid", "glm-5.3-flash"}, {"cf-or-paid", "openrouter", "paid", "glm-5.3-flash"}}
	if alt {
		routes = append(routes, route{"cf-alt", "zai", "free", "glm-4.7-flash"})
	}
	for _, v := range routes {
		a := &auth.Auth{ID: v.id, Provider: e.Identifier(), Status: auth.StatusActive}
		if _, err := manager.Register(context.Background(), a); err != nil {
			t.Fatal(err)
		}
		info := &registry.ModelInfo{ID: v.base, CanonicalID: v.base, CanonicalPolicy: "canonical", CanonicalFree: v.policy == "free", OwnedBy: v.owner, ContextLength: 32768, MaxCompletionTokens: 4096, SupportedInputModalities: []string{"text"}, SupportedOutputModalities: []string{"text"}, SupportedParameters: []string{"tools", "response_format"}}
		selector := *info
		selector.ID = v.base + ":" + v.policy
		selector.CanonicalSourceID = "upstream-" + v.base
		selector.CanonicalPolicy = v.policy
		selector.HideFromDiscovery = true
		registry.GetGlobalRegistry().RegisterClient(v.id, a.Provider, []*registry.ModelInfo{info, &selector})
		id := v.id
		t.Cleanup(func() { registry.GetGlobalRegistry().UnregisterClient(id) })
	}
	h := NewBaseAPIHandlers(&sdkconfig.SDKConfig{Streaming: sdkconfig.StreamingConfig{BootstrapRetries: 4}}, manager)
	return h, e
}
func TestCanonicalPlainFreeThenSameModelPaid(t *testing.T) {
	h, e := canonicalFixture(t, map[string]int{"cf-kilo": 503, "cf-other": 503, "cf-paid": 503}, false)
	_, headers, err := h.ExecuteWithAuthManager(context.Background(), "openai", "glm-5.3-flash", []byte(`{"model":"glm-5.3-flash","messages":[{"role":"user","content":"hello"}],"max_tokens":20}`), "")
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"cf-kilo/upstream-glm-5.3-flash", "cf-other/upstream-glm-5.3-flash", "cf-paid/upstream-glm-5.3-flash", "cf-or-paid/upstream-glm-5.3-flash"}
	if !reflect.DeepEqual(e.calls, want) {
		t.Fatal(e.calls)
	}
	if headers.Get("X-Gateway-Provider") != "openrouter" {
		t.Fatal(headers)
	}
}
func TestCanonicalFreeNeverPaidAndSimilarFallback(t *testing.T) {
	h, e := canonicalFixture(t, map[string]int{"cf-kilo": 503, "cf-other": 503}, true)
	_, headers, err := h.ExecuteWithAuthManager(context.Background(), "openai", "glm-5.3-flash:free", []byte(`{"model":"glm-5.3-flash:free","messages":[{"role":"user","content":"hello"}],"max_tokens":20}`), "")
	if err != nil {
		t.Fatal(err)
	}
	if len(e.calls) != 3 || e.calls[2] != "cf-alt/upstream-glm-4.7-flash" {
		t.Fatal(e.calls)
	}
	if headers.Get("X-Gateway-Resolved-Model") != "glm-4.7-flash" || headers.Get("X-Gateway-Cost-Policy") != "free-only" {
		t.Fatal(headers)
	}
}
func TestCanonicalAuthenticationAndUncertainErrorsNeverFallback(t *testing.T) {
	for _, status := range []int{400, 401, 403, 502, 504} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			h, e := canonicalFixture(t, map[string]int{"cf-kilo": status}, true)
			_, _, err := h.ExecuteWithAuthManager(context.Background(), "openai", "glm-5.3-flash:free", []byte(`{"model":"glm-5.3-flash:free"}`), "")
			if err == nil || len(e.calls) != 1 || e.refresh != 0 {
				t.Fatal(err, e.calls, e.refresh)
			}
		})
	}
}
func TestCanonicalStreamingStopsFallbackAfterOutput(t *testing.T) {
	h, e := canonicalFixture(t, nil, true)
	e.late = true
	data, _, errs := h.ExecuteStreamWithAuthManager(context.Background(), "openai", "glm-5.3-flash:free", []byte(`{"model":"glm-5.3-flash:free"}`), "")
	for range data {
	}
	for range errs {
	}
	if len(e.calls) != 1 {
		t.Fatal(e.calls)
	}
}
func TestCanonicalStreamingCanFallbackBeforeOutput(t *testing.T) {
	h, e := canonicalFixture(t, map[string]int{"cf-kilo": 503, "cf-other": 503}, true)
	data, headers, errs := h.ExecuteStreamWithAuthManager(context.Background(), "openai", "glm-5.3-flash:free", []byte(`{"model":"glm-5.3-flash:free","max_tokens":20}`), "")
	n := 0
	for chunk := range data {
		n += len(chunk)
	}
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	if n == 0 || len(e.calls) != 3 || headers.Get("X-Gateway-Resolved-Model") != "glm-4.7-flash" {
		t.Fatal(e.calls, headers, n)
	}
}
func TestCanonicalFallbackCapabilitiesFailClosed(t *testing.T) {
	info := &registry.ModelInfo{CanonicalFree: true, ContextLength: 10000, MaxCompletionTokens: 100, SupportedInputModalities: []string{"text"}, SupportedOutputModalities: []string{"text"}}
	for _, body := range []string{`{"tools":[{}]}`, `{"thinking":{"type":"enabled"}}`, `{"response_format":{"type":"json_object"}}`, `{"messages":[{"content":[{"type":"image_url","image_url":"x"}]}]}`, `{"max_tokens":101}`} {
		r, err := canonicalRequestRequirements([]byte(body))
		if err != nil || canonicalCompatible(info, r) {
			t.Fatal(body, err)
		}
	}
}
