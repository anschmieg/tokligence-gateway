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
	hostCallbackID string
	method         string
	url            string
	body           []byte
	auth           string
}

type fakeResponse struct {
	status int
	body   []byte
}

func (f *fakeTransport) Do(hostCallbackID, method, url string, headers map[string][]string, body []byte) (int, []byte, error) {
	auth := ""
	if values := headers["Authorization"]; len(values) > 0 {
		auth = values[0]
	}
	f.calls = append(f.calls, fakeCall{hostCallbackID: hostCallbackID, method: method, url: url, body: body, auth: auth})
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

func TestRegisterAcceptsHostYAMLConfig(t *testing.T) {
	// The host hands the original YAML subtree with enabled/priority merged in.
	config := []byte(`enabled: true
priority: 0
api_base_url: https://api.cline.bot
models:
  - id: gpt-x
    display_name: GPT X
`)
	handler := NewHandler(nil)
	raw, err := handler.HandleMethod("plugin.register", mustMarshal(t, LifecycleRequest{
		ConfigYAML:    config,
		SchemaVersion: 10,
	}))
	if err != nil {
		t.Fatalf("plugin.register: %v", err)
	}
	var registration RegistrationResponse
	decodeResult(t, raw, &registration)
	if !registration.Capabilities.Executor {
		t.Fatal("executor capability missing after YAML registration")
	}
	modelsRaw, err := handler.HandleMethod("model.register", nil)
	if err != nil {
		t.Fatalf("model.register: %v", err)
	}
	var models PluginModels
	decodeResult(t, modelsRaw, &models)
	if len(models.Models) != 1 || models.Models[0].ID != "cline/gpt-x" {
		t.Fatalf("models = %+v", models.Models)
	}
}

func TestConfigureRejectsModelsListWithoutIds(t *testing.T) {
	handler := NewHandler(nil)
	err := handler.Configure([]byte("models:\n  - display_name: NoId\n"))
	if err == nil {
		t.Fatal("expected error when no model carries an id")
	}
}

func TestConfigureIsAtomicOnInvalidModels(t *testing.T) {
	handler := newConfiguredHandler(t, nil)
	originalURL := handler.apiBaseURL
	// A reconfigure that fails mid-parse must not leave the earlier fields
	// applied while the catalog stays stale.
	err := handler.Configure([]byte("api_base_url: https://api.cline.example\nmodels:\n  - display_name: NoId\n"))
	if err == nil {
		t.Fatal("expected reconfigure failure")
	}
	if handler.apiBaseURL != originalURL {
		t.Fatalf("failed reconfigure must not mutate api_base_url: %q", handler.apiBaseURL)
	}
	raw, err := handler.HandleMethod("model.register", nil)
	if err != nil {
		t.Fatalf("catalog must survive failed reconfigure: %v", err)
	}
	var models PluginModels
	decodeResult(t, raw, &models)
	if len(models.Models) != 1 || models.Models[0].ID != "cline/gpt-x" {
		t.Fatalf("catalog was mutated by a failed reconfigure: %+v", models.Models)
	}
}

func TestConfigureRejectsInsecureBaseURLs(t *testing.T) {
	handler := newConfiguredHandler(t, nil)
	err := handler.Configure([]byte("api_base_url: http://api.cline.bot\nmodels:\n  - id: gpt-x\n"))
	if err == nil {
		t.Fatal("plaintext non-loopback api_base_url must be rejected")
	}
	if !strings.Contains(err.Error(), "HTTPS") {
		t.Fatalf("error = %v", err)
	}
	err = handler.Configure([]byte("api_base_url: ftp://api.cline.bot\nmodels:\n  - id: gpt-x\n"))
	if err == nil {
		t.Fatal("non-http scheme must be rejected")
	}
}

func TestConfigureAllowsLoopbackHTTPForIsolatedTests(t *testing.T) {
	handler := newConfiguredHandler(t, nil)
	err := handler.Configure([]byte("api_base_url: http://127.0.0.1:8080\nmodels:\n  - id: gpt-x\n"))
	if err != nil {
		t.Fatalf("loopback http must be allowed for isolated tests: %v", err)
	}
	if handler.apiBaseURL != "http://127.0.0.1:8080" {
		t.Fatalf("api base url = %q", handler.apiBaseURL)
	}
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
	if response.Auth.ID != "cline:cline.json" {
		t.Fatalf("auth id = %q, want per-file identity", response.Auth.ID)
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

func TestAuthParseIDsAreUniquePerFileAndStable(t *testing.T) {
	handler := newConfiguredHandler(t, nil)
	expiry := time.Now().UTC().Add(2 * time.Hour).Format(time.RFC3339)
	credential := []byte(`{"accessToken":"at","refreshToken":"rt","expiresAt":"` + expiry + `"}`)
	ids := map[string]bool{}
	for _, fileName := range []string{"cline.json", "cline-2.json", "cline.json"} {
		request := mustMarshal(t, AuthParseRequest{Provider: ProviderKey, FileName: fileName, RawJSON: credential})
		raw, err := handler.HandleMethod("auth.parse", request)
		if err != nil {
			t.Fatalf("auth.parse: %v", err)
		}
		var response AuthParseResponse
		decodeResult(t, raw, &response)
		if !response.Handled {
			t.Fatalf("expected %s to be handled", fileName)
		}
		if ids[response.Auth.ID] && fileName != "cline.json" {
			t.Fatalf("auth id %q is not unique across files", response.Auth.ID)
		}
		if response.Auth.ID != AuthIDForFileName(fileName) {
			t.Fatalf("auth id %q must stay stable for %s", response.Auth.ID, fileName)
		}
		ids[response.Auth.ID] = true
	}
	if len(ids) != 2 {
		t.Fatalf("expected two distinct ids for two files, got %v", ids)
	}
}

func TestAuthParseRefusesForeignProviderCredentialShapedData(t *testing.T) {
	handler := newConfiguredHandler(t, nil)
	expiry := time.Now().UTC().Add(2 * time.Hour).Format(time.RFC3339)
	// A foreign provider's file that happens to carry cline-shaped tokens must
	// not be claimed: that would steal another provider's credential.
	request := mustMarshal(t, AuthParseRequest{
		Provider: "codex",
		FileName: "codex.json",
		RawJSON:  []byte(`{"accessToken":"at","refreshToken":"rt","expiresAt":"` + expiry + `"}`),
	})
	raw, err := handler.HandleMethod("auth.parse", request)
	if err != nil {
		t.Fatalf("auth.parse: %v", err)
	}
	var response AuthParseResponse
	decodeResult(t, raw, &response)
	if response.Handled {
		t.Fatal("foreign provider's cline-shaped data must not be handled")
	}
}

func TestAuthParsePassesOnForeignCredential(t *testing.T) {
	handler := newConfiguredHandler(t, nil)
	request := mustMarshal(t, AuthParseRequest{
		Provider: ProviderKey,
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

func TestAuthRefreshPreservesHostIdentityAndForwardsCallbackID(t *testing.T) {
	transport := &fakeTransport{
		responses: []fakeResponse{
			{status: 200, body: []byte(`{"success":true,"data":{"accessToken":"at2","refreshToken":"rt2","expiresAt":"2030-11-01T13:00:00Z"}}`)},
		},
	}
	handler := newConfiguredHandler(t, transport)
	request := mustMarshal(t, AuthRefreshRequest{
		AuthID:         "cline:cline.json",
		AuthProvider:   ProviderKey,
		StorageJSON:    []byte(`{"accessToken":"at1","refreshToken":"rt1","expiresAt":"2030-11-01T12:00:00Z"}`),
		Metadata:       map[string]any{"type": ProviderKey, "oauth_provider": ProviderKey},
		Attributes:     map[string]string{"path": "/auths/cline.json"},
		HostCallbackID: "cb-42",
	})
	raw, err := handler.HandleMethod("auth.refresh", request)
	if err != nil {
		t.Fatalf("auth.refresh: %v", err)
	}
	var response AuthRefreshResponse
	decodeResult(t, raw, &response)
	// The refreshed record must keep the host-assigned identity; a collapsed
	// identity would fork the credential into a second auth record.
	if response.Auth.ID != "cline:cline.json" {
		t.Fatalf("refresh must preserve AuthID, got %q", response.Auth.ID)
	}
	if response.Auth.Metadata["oauth_provider"] != ProviderKey {
		t.Fatalf("refresh must preserve metadata, got %v", response.Auth.Metadata)
	}
	if response.Auth.Attributes["path"] != "/auths/cline.json" {
		t.Fatalf("refresh must preserve attributes, got %v", response.Auth.Attributes)
	}
	if len(transport.calls) != 1 || transport.calls[0].hostCallbackID != "cb-42" {
		t.Fatalf("host callback id must be forwarded to host.http.do, calls = %+v", transport.calls)
	}
}

func TestAuthRefreshRejectsForeignProvider(t *testing.T) {
	transport := &fakeTransport{}
	handler := newConfiguredHandler(t, transport)
	request := mustMarshal(t, AuthRefreshRequest{
		AuthID:       "cline:cline.json",
		AuthProvider: "codex",
		StorageJSON:  []byte(`{"accessToken":"at1","refreshToken":"rt1","expiresAt":"2030-11-01T12:00:00Z"}`),
	})
	_, err := handler.HandleMethod("auth.refresh", request)
	if err == nil {
		t.Fatal("expected refresh rejection for foreign auth provider")
	}
	if len(transport.calls) != 0 {
		t.Fatalf("a rejected refresh must not contact the provider, calls = %d", len(transport.calls))
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

func TestRegistrationDeclaresModelProviderCapability(t *testing.T) {
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
	if !registration.Capabilities.ModelProvider {
		t.Fatal("model_provider capability must be declared for oauth-scope per-auth publication")
	}
}

func TestModelStaticOffersNoStaticModels(t *testing.T) {
	// Executor scope is "oauth": the host skips static publication, and the
	// plugin must not offer static models through model.static either.
	handler := newConfiguredHandler(t, nil)
	raw, err := handler.HandleMethod("model.static", nil)
	if err != nil {
		t.Fatalf("model.static: %v", err)
	}
	var response ModelResponse
	decodeResult(t, raw, &response)
	if len(response.Models) != 0 {
		t.Fatalf("model.static must offer no static models, got %+v", response.Models)
	}
}

func TestModelForAuthPublishesCatalogForOwnProvider(t *testing.T) {
	handler := newConfiguredHandler(t, nil)
	request := mustMarshal(t, AuthModelRequest{
		AuthID:       "cline:cline.json",
		AuthProvider: ProviderKey,
		StorageJSON:  []byte(`{"accessToken":"at","refreshToken":"rt","expiresAt":"2030-11-01T12:00:00Z"}`),
	})
	raw, err := handler.HandleMethod("model.for_auth", request)
	if err != nil {
		t.Fatalf("model.for_auth: %v", err)
	}
	var response ModelResponse
	decodeResult(t, raw, &response)
	if response.Provider != ProviderKey {
		t.Fatalf("provider = %q", response.Provider)
	}
	if len(response.Models) != 1 || response.Models[0].ID != "cline/gpt-x" {
		t.Fatalf("models = %+v", response.Models)
	}
}

func TestModelForAuthRefusesForeignProvider(t *testing.T) {
	handler := newConfiguredHandler(t, nil)
	request := mustMarshal(t, AuthModelRequest{
		AuthID:       "codex:codex.json",
		AuthProvider: "codex",
		StorageJSON:  []byte(`{"accessToken":"at","refreshToken":"rt","expiresAt":"2030-11-01T12:00:00Z"}`),
	})
	raw, err := handler.HandleMethod("model.for_auth", request)
	if err != nil {
		t.Fatalf("model.for_auth: %v", err)
	}
	var response ModelResponse
	decodeResult(t, raw, &response)
	if len(response.Models) != 0 {
		t.Fatalf("a foreign provider's credential must get no cline models, got %+v", response.Models)
	}
}

func TestExecuteFailsClosedWithoutTransport(t *testing.T) {
	// Without the host transport no upstream call is possible; returning the
	// translated request would fabricate a successful inference response.
	handler := newConfiguredHandler(t, nil)
	request := mustMarshal(t, ExecutorRequest{
		AuthID:      ProviderKey,
		Model:       "cline/gpt-x",
		Payload:     []byte(`{"model":"cline/gpt-x","messages":[{"role":"user","content":"hi"}],"max_tokens":8}`),
		StorageJSON: []byte(`{"accessToken":"at","refreshToken":"rt","expiresAt":"2030-11-01T12:00:00Z"}`),
	})
	_, err := handler.HandleMethod("executor.execute", request)
	if err == nil {
		t.Fatal("expected fail-closed error without transport")
	}
	if !strings.Contains(err.Error(), "transport is unavailable") {
		t.Fatalf("error = %v", err)
	}
}

func TestExecuteStreamRequestFailsBeforeAnyHTTP(t *testing.T) {
	// A stream=true request must fail regardless of which executor method the
	// host used to deliver it, and before any upstream call is attempted.
	transport := &fakeTransport{}
	handler := newConfiguredHandler(t, transport)
	request := mustMarshal(t, ExecutorRequest{
		AuthID:      ProviderKey,
		Model:       "cline/gpt-x",
		Stream:      true,
		Payload:     []byte(`{"model":"cline/gpt-x","messages":[],"stream":true}`),
		StorageJSON: []byte(`{"accessToken":"at","refreshToken":"rt","expiresAt":"2030-11-01T12:00:00Z"}`),
	})
	_, err := handler.HandleMethod("executor.execute", request)
	if err == nil {
		t.Fatal("expected stream rejection through executor.execute")
	}
	if !strings.Contains(err.Error(), "not implemented") {
		t.Fatalf("error = %v", err)
	}
	if len(transport.calls) != 0 {
		t.Fatalf("stream request must not contact upstream, calls = %d", len(transport.calls))
	}
}

func TestExecuteRejectsHTTP200ErrorBody(t *testing.T) {
	transport := &fakeTransport{
		responses: []fakeResponse{
			{status: 200, body: []byte(`{"success":false,"error":{"message":"denied"}}`)},
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
		t.Fatal("HTTP 200 with success=false must not count as success")
	}
}

func TestExecuteRejectsMalformedHTTP200Body(t *testing.T) {
	transport := &fakeTransport{
		responses: []fakeResponse{
			{status: 200, body: []byte(`not json at all`)},
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
		t.Fatal("malformed HTTP 200 body must not count as success")
	}
}

func TestExecuteRejectsEmptyHTTP200Body(t *testing.T) {
	transport := &fakeTransport{
		responses: []fakeResponse{
			{status: 200, body: nil},
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
		t.Fatal("empty HTTP 200 body must not count as success")
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

func TestUpstreamErrorsNeverEchoAccessToken(t *testing.T) {
	// Terminal and quota failures classify into fixed messages; the credential
	// token values must never reach error strings.
	transport := &fakeTransport{
		responses: []fakeResponse{
			{status: 401, body: []byte(`{"error":"at"}`)},
			{status: 429, body: []byte(`{"message":"free limit reached on model gpt-x"}`)},
			{status: 500, body: []byte(`Bearer workos:at`)},
		},
	}
	handler := newConfiguredHandler(t, transport)
	request := mustMarshal(t, ExecutorRequest{
		AuthID:      ProviderKey,
		Model:       "cline/gpt-x",
		Payload:     []byte(`{"model":"cline/gpt-x","messages":[]}`),
		StorageJSON: []byte(`{"accessToken":"secret-access-token","refreshToken":"rt","expiresAt":"2030-11-01T12:00:00Z"}`),
	})
	for i := 0; i < 3; i++ {
		_, err := handler.HandleMethod("executor.execute", request)
		if err == nil {
			t.Fatalf("call %d: expected upstream failure", i)
		}
		if strings.Contains(err.Error(), "secret-access-token") || strings.Contains(err.Error(), "workos:secret") {
			t.Fatalf("call %d: error leaks the access token: %v", i, err)
		}
	}
}

func TestUnsupportedOperationsFailExplicitly(t *testing.T) {
	handler := newConfiguredHandler(t, nil)
	unsupported := map[string][]byte{
		"auth.login.start":      mustMarshal(t, AuthLoginStartRequest{Provider: ProviderKey}),
		"auth.login.poll":       mustMarshal(t, AuthLoginPollRequest{Provider: ProviderKey}),
		"executor.count_tokens": mustMarshal(t, ExecutorRequest{Model: "cline/gpt-x"}),
		"executor.http_request": mustMarshal(t, ExecutorRequest{Model: "cline/gpt-x"}),
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
