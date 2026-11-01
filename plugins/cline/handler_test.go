package cline

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

// fakeTransport records calls and returns scripted responses without network.
type fakeTransport struct {
	calls     []fakeCall
	responses []fakeResponse
	next      int
}

type fakeCall struct {
	method string
	url    string
	body   []byte
	auth   string
}

type fakeResponse struct {
	status int
	body   []byte
}

func (f *fakeTransport) Do(method, url string, headers map[string][]string, body []byte) (int, []byte, error) {
	auth := ""
	if values := headers["Authorization"]; len(values) > 0 {
		auth = values[0]
	}
	f.calls = append(f.calls, fakeCall{method: method, url: url, body: body, auth: auth})
	if f.next < len(f.responses) {
		resp := f.responses[f.next]
		f.next++
		return resp.status, resp.body, nil
	}
	return 500, []byte(`{"error":"no scripted response"}`), nil
}

func newConfiguredHandler(t *testing.T, transport Transport) *Handler {
	t.Helper()
	handler := NewHandler(transport)
	config := []byte(`{"api_base_url":"https://api.cline.bot","models":[{"id":"gpt-x","display_name":"GPT X"}]}`)
	result, err := handler.HandleMethod("plugin.register", mustMarshal(t, LifecycleRequest{
		ConfigYAML:    config,
		SchemaVersion: 10,
	}))
	if err != nil {
		t.Fatalf("plugin.register: %v", err)
	}
	var registration RegistrationResponse
	decodeResult(t, result, &registration)
	return handler
}

func mustMarshal(t *testing.T, value any) []byte {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return raw
}

func decodeResult(t *testing.T, envelope []byte, target any) {
	t.Helper()
	var env struct {
		OK     bool            `json:"ok"`
		Result json.RawMessage `json:"result"`
		Error  *struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(envelope, &env); err != nil {
		t.Fatalf("decode envelope: %v", err)
	}
	if !env.OK {
		t.Fatalf("envelope error: %+v", env.Error)
	}
	if err := json.Unmarshal(env.Result, target); err != nil {
		t.Fatalf("decode result: %v", err)
	}
}

func TestRegistrationDeclaresSchema10AndCapabilities(t *testing.T) {
	handler := newConfiguredHandler(t, nil)
	raw, err := handler.HandleMethod("plugin.register", mustMarshal(t, LifecycleRequest{
		ConfigYAML:    []byte(`{"models":[{"id":"gpt-x"}]}`),
		SchemaVersion: 10,
	}))
	if err != nil {
		t.Fatalf("plugin.register: %v", err)
	}
	var registration RegistrationResponse
	decodeResult(t, raw, &registration)
	if registration.SchemaVersion != 10 {
		t.Fatalf("schema version = %d", registration.SchemaVersion)
	}
	if !registration.Capabilities.AuthProvider || !registration.Capabilities.Executor || !registration.Capabilities.ModelRegistrar {
		t.Fatalf("capabilities = %+v", registration.Capabilities)
	}
	if registration.Capabilities.ExecutorModelScope != "oauth" {
		t.Fatalf("executor scope = %q", registration.Capabilities.ExecutorModelScope)
	}
	if len(registration.Capabilities.ExecutorInputFormats) != 1 || registration.Capabilities.ExecutorInputFormats[0] != "openai" {
		t.Fatalf("input formats = %v", registration.Capabilities.ExecutorInputFormats)
	}
	if registration.Metadata.Name != "tokligence-cline" {
		t.Fatalf("metadata = %+v", registration.Metadata)
	}
}

func TestIdentifierMethods(t *testing.T) {
	handler := newConfiguredHandler(t, nil)
	for _, method := range []string{"auth.identifier", "executor.identifier"} {
		raw, err := handler.HandleMethod(method, nil)
		if err != nil {
			t.Fatalf("%s: %v", method, err)
		}
		var result map[string]string
		decodeResult(t, raw, &result)
		if result["identifier"] != ProviderKey {
			t.Fatalf("%s = %q", method, result["identifier"])
		}
	}
}

func TestAuthParseHandlesClineCredentialFile(t *testing.T) {
	handler := newConfiguredHandler(t, nil)
	expiry := time.Now().UTC().Add(2 * time.Hour).Format(time.RFC3339)
	request := mustMarshal(t, AuthParseRequest{
		Provider: ProviderKey,
		FileName: "cline.json",
		RawJSON:  []byte(`{"accessToken":"at","refreshToken":"rt","expiresAt":"` + expiry + `"}`),
	})
	raw, err := handler.HandleMethod("auth.parse", request)
	if err != nil {
		t.Fatalf("auth.parse: %v", err)
	}
	var response AuthParseResponse
	decodeResult(t, raw, &response)
	if !response.Handled {
		t.Fatal("expected handled auth parse")
	}
	if response.Auth.Provider != ProviderKey {
		t.Fatalf("provider = %q", response.Auth.Provider)
	}
	if response.Auth.FileName != "cline.json" {
		t.Fatalf("file name = %q", response.Auth.FileName)
	}
	var storage Storage
	if err := json.Unmarshal(response.Auth.StorageJSON, &storage); err != nil {
		t.Fatalf("storage json: %v", err)
	}
	if storage.AccessToken != "at" || storage.RefreshToken != "rt" {
		t.Fatalf("storage = %+v", storage)
	}
	if response.Auth.NextRefreshAfter.IsZero() {
		t.Fatal("next refresh must be scheduled from expiry")
	}
}

func TestAuthParsePassesOnForeignCredential(t *testing.T) {
	handler := newConfiguredHandler(t, nil)
	request := mustMarshal(t, AuthParseRequest{
		Provider: "codex",
		RawJSON:  []byte(`{"id_token":"x","refresh_token":"y"}`),
	})
	raw, err := handler.HandleMethod("auth.parse", request)
	if err != nil {
		t.Fatalf("auth.parse: %v", err)
	}
	var response AuthParseResponse
	decodeResult(t, raw, &response)
	if response.Handled {
		t.Fatal("foreign credential must not be handled")
	}
}

func TestAuthRefreshRotatesCredential(t *testing.T) {
	transport := &fakeTransport{
		responses: []fakeResponse{
			{status: 200, body: []byte(`{"success":true,"data":{"accessToken":"at2","refreshToken":"rt2","expiresAt":"2030-11-01T13:00:00Z"}}`)},
		},
	}
	handler := newConfiguredHandler(t, transport)
	request := mustMarshal(t, AuthRefreshRequest{
		AuthID:       ProviderKey,
		AuthProvider: ProviderKey,
		StorageJSON:  []byte(`{"accessToken":"at1","refreshToken":"rt1","expiresAt":"2030-11-01T12:00:00Z"}`),
	})
	raw, err := handler.HandleMethod("auth.refresh", request)
	if err != nil {
		t.Fatalf("auth.refresh: %v", err)
	}
	var response AuthRefreshResponse
	decodeResult(t, raw, &response)
	if len(transport.calls) != 1 {
		t.Fatalf("expected exactly one refresh call, got %d", len(transport.calls))
	}
	call := transport.calls[0]
	if call.method != "POST" || call.url != "https://api.cline.bot/api/v1/auth/refresh" {
		t.Fatalf("refresh call = %+v", call)
	}
	var body map[string]any
	if err := json.Unmarshal(call.body, &body); err != nil {
		t.Fatalf("refresh body: %v", err)
	}
	if body["refreshToken"] != "rt1" || body["grantType"] != "refresh_token" {
		t.Fatalf("refresh body = %v", body)
	}
	var storage Storage
	if err := json.Unmarshal(response.Auth.StorageJSON, &storage); err != nil {
		t.Fatalf("storage: %v", err)
	}
	if storage.AccessToken != "at2" || storage.RefreshToken != "rt2" {
		t.Fatalf("rotated storage = %+v", storage)
	}
	if response.NextRefreshAfter.Format(time.RFC3339) != "2030-11-01T12:55:00Z" {
		t.Fatalf("next refresh = %v", response.NextRefreshAfter)
	}
}

func TestAuthRefreshKeepsRefreshTokenWhenNotRotated(t *testing.T) {
	transport := &fakeTransport{
		responses: []fakeResponse{
			{status: 200, body: []byte(`{"success":true,"data":{"accessToken":"at2","expiresAt":"2030-11-01T13:00:00Z"}}`)},
		},
	}
	handler := newConfiguredHandler(t, transport)
	request := mustMarshal(t, AuthRefreshRequest{
		AuthID:       ProviderKey,
		AuthProvider: ProviderKey,
		StorageJSON:  []byte(`{"accessToken":"at1","refreshToken":"rt1","expiresAt":"2030-11-01T12:00:00Z"}`),
	})
	raw, err := handler.HandleMethod("auth.refresh", request)
	if err != nil {
		t.Fatalf("auth.refresh: %v", err)
	}
	var response AuthRefreshResponse
	decodeResult(t, raw, &response)
	var storage Storage
	if err := json.Unmarshal(response.Auth.StorageJSON, &storage); err != nil {
		t.Fatalf("storage: %v", err)
	}
	if storage.RefreshToken != "rt1" {
		t.Fatalf("refresh token must be retained, got %+v", storage)
	}
}

func TestAuthRefreshAuthFailureIsTerminalAndNotRetried(t *testing.T) {
	transport := &fakeTransport{
		responses: []fakeResponse{
			{status: 401, body: []byte(`{"error":"invalid token"}`)},
		},
	}
	handler := newConfiguredHandler(t, transport)
	request := mustMarshal(t, AuthRefreshRequest{
		AuthID:       ProviderKey,
		AuthProvider: ProviderKey,
		StorageJSON:  []byte(`{"accessToken":"at1","refreshToken":"rt1","expiresAt":"2030-11-01T12:00:00Z"}`),
	})
	_, err := handler.HandleMethod("auth.refresh", request)
	if err == nil {
		t.Fatal("expected auth failure error")
	}
	if !strings.Contains(err.Error(), "Cline login is missing or expired") {
		t.Fatalf("error = %v", err)
	}
	if len(transport.calls) != 1 {
		t.Fatalf("a rejected refresh must not be retried, calls = %d", len(transport.calls))
	}
}

func TestAuthRefreshQuotaErrorIsTerminalAndNotRetried(t *testing.T) {
	transport := &fakeTransport{
		responses: []fakeResponse{
			{status: 429, body: []byte(`{"message":"free limit reached on model gpt-x"}`)},
		},
	}
	handler := newConfiguredHandler(t, transport)
	request := mustMarshal(t, AuthRefreshRequest{
		AuthID:       ProviderKey,
		AuthProvider: ProviderKey,
		StorageJSON:  []byte(`{"accessToken":"at1","refreshToken":"rt1","expiresAt":"2030-11-01T12:00:00Z"}`),
	})
	_, err := handler.HandleMethod("auth.refresh", request)
	if err == nil {
		t.Fatal("expected quota error")
	}
	if !strings.Contains(err.Error(), "daily free quota is exhausted") {
		t.Fatalf("error = %v", err)
	}
	if len(transport.calls) != 1 {
		t.Fatalf("a quota rejection must not be retried, calls = %d", len(transport.calls))
	}
}

func TestAuthRefreshRejectsInvalidStoredCredential(t *testing.T) {
	handler := newConfiguredHandler(t, &fakeTransport{})
	request := mustMarshal(t, AuthRefreshRequest{
		AuthID:       ProviderKey,
		AuthProvider: ProviderKey,
		StorageJSON:  []byte(`{"accessToken":"","refreshToken":"","expiresAt":"x"}`),
	})
	_, err := handler.HandleMethod("auth.refresh", request)
	if err == nil {
		t.Fatal("expected error for invalid storage")
	}
}

func TestModelRegisterPublishesConfiguredCatalog(t *testing.T) {
	handler := newConfiguredHandler(t, nil)
	raw, err := handler.HandleMethod("model.register", nil)
	if err != nil {
		t.Fatalf("model.register: %v", err)
	}
	var models PluginModels
	decodeResult(t, raw, &models)
	if models.Provider != ProviderKey {
		t.Fatalf("provider = %q", models.Provider)
	}
	if len(models.Models) != 1 || models.Models[0].ID != "cline/gpt-x" {
		t.Fatalf("models = %+v", models.Models)
	}
	if models.Models[0].DisplayName != "GPT X" {
		t.Fatalf("display name = %q", models.Models[0].DisplayName)
	}
}

func TestExecuteTranslatesRequestWithoutTransport(t *testing.T) {
	// Build-only mode (nil transport): the translated upstream payload is
	// returned so a harness can assert it without contacting the provider.
	handler := newConfiguredHandler(t, nil)
	payload := []byte(`{"model":"cline/gpt-x","messages":[{"role":"user","content":"hi"}],"max_tokens":8}`)
	request := mustMarshal(t, ExecutorRequest{
		AuthID:      ProviderKey,
		Model:       "cline/gpt-x",
		Payload:     payload,
		StorageJSON: []byte(`{"accessToken":"at","refreshToken":"rt","expiresAt":"2030-11-01T12:00:00Z"}`),
	})
	raw, err := handler.HandleMethod("executor.execute", request)
	if err != nil {
		t.Fatalf("executor.execute: %v", err)
	}
	var response ExecutorResponse
	decodeResult(t, raw, &response)
	var body map[string]any
	if err := json.Unmarshal(response.Payload, &body); err != nil {
		t.Fatalf("payload: %v", err)
	}
	if body["model"] != "gpt-x" {
		t.Fatalf("model = %v", body["model"])
	}
	if body["max_tokens"] != float64(MinTokenFloor) {
		t.Fatalf("max_tokens = %v", body["max_tokens"])
	}
	if response.Headers["x-cline-upstream-model"][0] != "gpt-x" {
		t.Fatalf("upstream model header = %v", response.Headers)
	}
}

func TestExecuteRejectsUnregisteredModel(t *testing.T) {
	handler := newConfiguredHandler(t, nil)
	request := mustMarshal(t, ExecutorRequest{
		Model:       "cline/unknown-model",
		Payload:     []byte(`{"model":"cline/unknown-model"}`),
		StorageJSON: []byte(`{"accessToken":"at","refreshToken":"rt","expiresAt":"2030-11-01T12:00:00Z"}`),
	})
	if _, err := handler.HandleMethod("executor.execute", request); err == nil {
		t.Fatal("expected unregistered model rejection")
	}
}

func TestExecuteRejectsMissingCredential(t *testing.T) {
	handler := newConfiguredHandler(t, nil)
	request := mustMarshal(t, ExecutorRequest{
		Model:       "cline/gpt-x",
		Payload:     []byte(`{"model":"cline/gpt-x"}`),
		StorageJSON: []byte(`{}`),
	})
	_, err := handler.HandleMethod("executor.execute", request)
	if err == nil {
		t.Fatal("expected credential error")
	}
	if !strings.Contains(err.Error(), "credential is unavailable") {
		t.Fatalf("error = %v", err)
	}
}

func TestExecuteWithTransportSendsTranslationAndNormalizesResponse(t *testing.T) {
	transport := &fakeTransport{
		responses: []fakeResponse{
			{status: 200, body: []byte(`{"success":true,"data":{"id":"cc","object":"chat.completion","choices":[{"message":{"role":"assistant","content":"ok"}}]}}`)},
		},
	}
	handler := newConfiguredHandler(t, transport)
	payload := []byte(`{"model":"cline/gpt-x","messages":[{"role":"user","content":"hi"}],"max_tokens":8,"stream":false}`)
	request := mustMarshal(t, ExecutorRequest{
		AuthID:      ProviderKey,
		Model:       "cline/gpt-x",
		Payload:     payload,
		StorageJSON: []byte(`{"accessToken":"at","refreshToken":"rt","expiresAt":"2030-11-01T12:00:00Z"}`),
	})
	raw, err := handler.HandleMethod("executor.execute", request)
	if err != nil {
		t.Fatalf("executor.execute: %v", err)
	}
	if len(transport.calls) != 1 {
		t.Fatalf("expected exactly one upstream call, got %d", len(transport.calls))
	}
	call := transport.calls[0]
	if call.url != "https://api.cline.bot/api/v1/chat/completions" {
		t.Fatalf("url = %q", call.url)
	}
	if call.auth != "Bearer workos:at" {
		t.Fatalf("authorization = %q", call.auth)
	}
	var sent map[string]any
	if err := json.Unmarshal(call.body, &sent); err != nil {
		t.Fatalf("sent body: %v", err)
	}
	if sent["model"] != "gpt-x" {
		t.Fatalf("sent model = %v", sent["model"])
	}
	var response ExecutorResponse
	decodeResult(t, raw, &response)
	var normalized map[string]any
	if err := json.Unmarshal(response.Payload, &normalized); err != nil {
		t.Fatalf("normalized payload: %v", err)
	}
	if normalized["id"] != "cc" {
		t.Fatalf("normalized payload = %v", normalized)
	}
	if _, has := normalized["success"]; has {
		t.Fatal("success envelope must be unwrapped")
	}
}

func TestExecuteUpstreamQuotaErrorSurfacesClassification(t *testing.T) {
	transport := &fakeTransport{
		responses: []fakeResponse{
			{status: 429, body: []byte(`{"message":"free limit reached on model gpt-x"}`)},
		},
	}
	handler := newConfiguredHandler(t, transport)
	request := mustMarshal(t, ExecutorRequest{
		AuthID:      ProviderKey,
		Model:       "cline/gpt-x",
		Payload:     []byte(`{"model":"cline/gpt-x","messages":[]}`),
		StorageJSON: []byte(`{"accessToken":"at","refreshToken":"rt","expiresAt":"2030-11-01T12:00:00Z"}`),
	})
	_, err := handler.HandleMethod("executor.execute", request)
	if err == nil {
		t.Fatal("expected quota error")
	}
	if !strings.Contains(err.Error(), "daily free quota is exhausted") {
		t.Fatalf("error = %v", err)
	}
	if len(transport.calls) != 1 {
		t.Fatalf("quota rejection must not be retried, calls = %d", len(transport.calls))
	}
}

func TestExecuteUpstreamAuthErrorSurfacesClassification(t *testing.T) {
	transport := &fakeTransport{
		responses: []fakeResponse{
			{status: 403, body: []byte(`{"error":"denied"}`)},
		},
	}
	handler := newConfiguredHandler(t, transport)
	request := mustMarshal(t, ExecutorRequest{
		AuthID:      ProviderKey,
		Model:       "cline/gpt-x",
		Payload:     []byte(`{"model":"cline/gpt-x","messages":[]}`),
		StorageJSON: []byte(`{"accessToken":"at","refreshToken":"rt","expiresAt":"2030-11-01T12:00:00Z"}`),
	})
	_, err := handler.HandleMethod("executor.execute", request)
	if err == nil {
		t.Fatal("expected auth error")
	}
	if !strings.Contains(err.Error(), "Cline login is missing or expired") {
		t.Fatalf("error = %v", err)
	}
}

func TestUnsupportedOperationsFailExplicitly(t *testing.T) {
	handler := newConfiguredHandler(t, nil)
	unsupported := map[string][]byte{
		"auth.login.start":        mustMarshal(t, AuthLoginStartRequest{Provider: ProviderKey}),
		"auth.login.poll":         mustMarshal(t, AuthLoginPollRequest{Provider: ProviderKey}),
		"executor.execute_stream": mustMarshal(t, ExecutorRequest{Model: "cline/gpt-x"}),
		"executor.count_tokens":   mustMarshal(t, ExecutorRequest{Model: "cline/gpt-x"}),
		"executor.http_request":   mustMarshal(t, ExecutorRequest{Model: "cline/gpt-x"}),
	}
	for method, request := range unsupported {
		if _, err := handler.HandleMethod(method, request); err == nil {
			t.Errorf("%s must fail as unsupported", method)
		} else if !strings.Contains(err.Error(), "not implemented") {
			t.Errorf("%s error should state unimplemented: %v", method, err)
		}
	}
}

func TestUnknownMethodFails(t *testing.T) {
	handler := newConfiguredHandler(t, nil)
	if _, err := handler.HandleMethod("bogus.method", nil); err == nil {
		t.Fatal("expected unknown method error")
	}
}

func TestRegisterWithoutModelsFails(t *testing.T) {
	handler := NewHandler(nil)
	_, err := handler.HandleMethod("plugin.register", mustMarshal(t, LifecycleRequest{
		ConfigYAML: []byte(`{}`),
	}))
	if err == nil {
		t.Fatal("configuration without models must fail")
	}
}
