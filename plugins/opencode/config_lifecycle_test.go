package opencode

import (
	"context"
	"encoding/json"
	"path/filepath"
	"reflect"
	"sync"
	"testing"
	"time"
)

func TestConfigureReusesLockAndPreservesStateOnFailure(t *testing.T) {
	h := newTestHandler(t, nil)
	path := filepath.Join(t.TempDir(), "sessions.json")
	cfg := []byte(testConfigYAML + "\nsession_state_path: " + path + "\n")
	if err := h.Configure(cfg); err != nil {
		t.Fatal(err)
	}
	registry := h.registry
	defer func() { h.registry.Close() }()
	id, err := registry.Create("p", "c")
	if err != nil {
		t.Fatal(err)
	}
	if err := h.Configure(cfg); err != nil {
		t.Fatalf("same path reacquired its own lock: %v", err)
	}
	if h.registry != registry || h.registry.Lookup("p", "c") != id {
		t.Fatal("reconfigure replaced session identity")
	}
	original := h.WithConfigured()
	blockedPath := filepath.Join(t.TempDir(), "other.json")
	other, err := NewSessionRegistry(RegistryOptions{Path: blockedPath})
	if err != nil {
		t.Fatal(err)
	}
	defer other.Close()
	if err := h.Configure([]byte(testConfigYAML + "\nsession_state_path: " + blockedPath + "\n")); err == nil {
		t.Fatal("foreign lock accepted")
	}
	if err := h.Configure([]byte("enabled: true\ninference_base_url: https://user:secret@example.com/v1\n")); err == nil {
		t.Fatal("credential URL accepted")
	}
	if !reflect.DeepEqual(original, h.WithConfigured()) || h.registry != registry {
		t.Fatal("failed configure changed live state")
	}
	snapshot := h.WithConfigured()
	snapshot.Models[0] = "mutated"
	if h.WithConfigured().Models[0] == "mutated" {
		t.Fatal("config snapshot aliases mutable state")
	}
}

type blockingConfigTransport struct {
	fakeTransport
	started chan struct{}
	resume  chan struct{}
	once    sync.Once
}

func (b *blockingConfigTransport) Do(ctx context.Context, method, url string, headers map[string][]string, body []byte) (HTTPResult, error) {
	b.once.Do(func() { close(b.started) })
	<-b.resume
	return HTTPResult{StatusCode: 200, Body: []byte(fixtureTextSSE)}, nil
}

func configLifecycleRequest(stream bool) []byte {
	req := map[string]any{
		"AuthID": "fixture-owner", "AuthProvider": ProviderKey, "Model": "beam-free",
		"StorageJSON": []byte(validCredential), "Stream": stream, "stream_id": "fixture-stream",
		"Payload":  []byte(`{"messages":[{"role":"user","content":"fixture"}]}`),
		"Metadata": map[string]any{"canonical_session_id": "fixture-conversation"},
	}
	raw, _ := json.Marshal(req)
	return raw
}

func TestConfigureRefusesDuringBufferedDispatch(t *testing.T) {
	transport := &blockingConfigTransport{started: make(chan struct{}), resume: make(chan struct{})}
	h := newTestHandler(t, transport)
	done := make(chan error, 1)
	go func() { _, err := h.HandleMethod("executor.execute", configLifecycleRequest(false)); done <- err }()
	select {
	case <-transport.started:
	case <-time.After(time.Second):
		t.Fatal("dispatch not started")
	}
	err := h.Configure([]byte(testConfigYAML))
	close(transport.resume)
	if err == nil || statusOf(err) != 409 {
		t.Fatalf("active dispatch reconfigure = %v", err)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if err := h.Configure([]byte(testConfigYAML)); err != nil {
		t.Fatal(err)
	}
}

func TestConfigureRefusesUntilAsyncPumpEnds(t *testing.T) {
	chunks := make(chan StreamChunk)
	transport := &fakeTransport{streamResult: StreamResult{StatusCode: 200, Chunks: chunks}}
	h := newTestHandler(t, transport)
	if _, err := h.HandleMethod("executor.execute_stream", configLifecycleRequest(true)); err != nil {
		t.Fatal(err)
	}
	err := h.Configure([]byte(testConfigYAML))
	close(chunks)
	if err == nil || statusOf(err) != 409 {
		t.Fatalf("active stream reconfigure = %v", err)
	}
	deadline := time.Now().Add(time.Second)
	for h.activeStreams.Load() != 0 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if h.activeStreams.Load() != 0 {
		t.Fatal("pump did not finish")
	}
	if err := h.Configure([]byte(testConfigYAML)); err != nil {
		t.Fatal(err)
	}
}

func TestConsoleURLRefusesCredentialLeakVariants(t *testing.T) {
	transport := &fakeTransport{}
	h := newTestHandler(t, transport)
	for _, target := range []string{
		"https://opencode.ai/console.evil/api/v2/config",
		"https://opencode.ai.evil/console/api/v2/config",
		"https://opencode.ai@evil.example/console/api/v2/config",
		"https://opencode.ai/console/../api/v2/config",
		"https://opencode.ai/console/%2e%2e/api/v2/config",
		"https://opencode.ai/console/api/v2/config?redirect=evil",
		"https://opencode.ai/console/api/v2/config#fragment",
		"http://opencode.ai/console/api/v2/config",
		"https://opencode.ai/console/api/delete",
	} {
		req, _ := json.Marshal(map[string]any{"Method": "GET", "URL": target, "StorageJSON": []byte(validCredential)})
		if _, err := h.HandleMethod("executor.http_request", req); err == nil || statusOf(err) != 403 {
			t.Errorf("unsafe URL admitted: %s (%v)", target, err)
		}
	}
	if len(transport.doCalls) != 0 {
		t.Fatal("URL rejection made HTTP request")
	}
}

func TestAuthProviderIsolationAndRefreshIdentity(t *testing.T) {
	transport := &fakeTransport{doResult: HTTPResult{StatusCode: 200, Body: []byte(`{"access_token":"new-access","refresh_token":"new-refresh","expires_in":3600}`)}}
	h := newTestHandler(t, transport)
	parse, _ := json.Marshal(map[string]any{"Provider": "cline", "RawJSON": []byte(validCredential)})
	raw, err := h.HandleMethod("auth.parse", parse)
	if err != nil {
		t.Fatal(err)
	}
	var parsed AuthParseResponse
	_ = json.Unmarshal(decodeOKEnvelope(t, raw), &parsed)
	if parsed.Handled {
		t.Fatal("foreign provider stolen")
	}
	req := map[string]any{"AuthID": "opencode:fixture.json", "AuthProvider": "cline", "StorageJSON": []byte(validCredential), "Metadata": map[string]any{"label": "kept"}, "Attributes": map[string]string{"type": "opencode"}}
	raw, _ = json.Marshal(req)
	if _, err := h.HandleMethod("auth.refresh", raw); err == nil {
		t.Fatal("foreign provider refreshed")
	}
	if len(transport.doCalls) != 0 {
		t.Fatal("foreign provider contacted upstream")
	}
	req["AuthProvider"] = ProviderKey
	raw, _ = json.Marshal(req)
	response, err := h.HandleMethod("auth.refresh", raw)
	if err != nil {
		t.Fatal(err)
	}
	var refreshed AuthRefreshResponse
	_ = json.Unmarshal(decodeOKEnvelope(t, response), &refreshed)
	if refreshed.Auth.ID != "opencode:fixture.json" || refreshed.Auth.Metadata["label"] != "kept" || refreshed.Auth.Attributes["type"] != "opencode" {
		t.Fatal("refresh lost host identity")
	}
}
