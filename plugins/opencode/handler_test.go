package opencode

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeTransport records upstream calls and answers with scripted results.
// It never touches the network.
type fakeTransport struct {
	doCalls       []recordedCall
	doStreamCalls []recordedCall
	doResult      HTTPResult
	doErr         error
	streamResult  StreamResult
	streamErr     error
	closed        int
}

type recordedCall struct {
	Method  string
	URL     string
	Headers map[string][]string
	Body    []byte
}

func (f *fakeTransport) Do(ctx context.Context, method, url string, headers map[string][]string, body []byte) (HTTPResult, error) {
	f.doCalls = append(f.doCalls, recordedCall{Method: method, URL: url, Headers: headers, Body: body})
	if f.doErr != nil {
		return HTTPResult{}, f.doErr
	}
	return f.doResult, nil
}

func (f *fakeTransport) DoStream(ctx context.Context, method, url string, headers map[string][]string, body []byte) (StreamResult, error) {
	f.doStreamCalls = append(f.doStreamCalls, recordedCall{Method: method, URL: url, Headers: headers, Body: body})
	if f.streamErr != nil {
		return StreamResult{}, f.streamErr
	}
	return f.streamResult, nil
}

func (f *fakeTransport) CloseStream(result StreamResult) { f.closed++ }

// testConfigYAML is a representative plugin configuration subtree.
const testConfigYAML = `
enabled: true
inference_base_url: https://opencode.ai/inference/openai/v1
models:
  - beam-free
  - glm-5.3-flash-free
app_name: cli
version: "2.0.32"
channel: latest
project_id: global
`

// validCredential is a native-shaped credential whose access token is valid
// at testNow.
const validCredential = `{
  "type": "oauth",
  "methodID": "device",
  "access": "live-access-token",
  "refresh": "live-refresh-token",
  "expires": 2000000000000,
  "metadata": {"server": "https://opencode.ai/console", "orgID": "org_1"}
}`

// testNow is the fixed clock for handler tests.
const testNow = 1000000000000

func newTestHandler(t *testing.T, transport Transport) *Handler {
	t.Helper()
	h := NewHandler(transport, func() int64 { return testNow })
	if err := h.Configure([]byte(testConfigYAML)); err != nil {
		t.Fatalf("Configure error = %v", err)
	}
	return h
}

func decodeOKEnvelope(t *testing.T, raw []byte) json.RawMessage {
	t.Helper()
	var envelope struct {
		OK     bool            `json:"ok"`
		Result json.RawMessage `json:"result"`
		Error  *struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(raw, &envelope); err != nil {
		t.Fatalf("decode envelope: %v (raw: %s)", err, raw)
	}
	if !envelope.OK {
		t.Fatalf("envelope error: %+v", envelope.Error)
	}
	return envelope.Result
}

// TestRegistrationDeclaresCapabilities pins the registration contract: the
// auth provider identifier, OAuth executor scope and openai formats.
func TestRegistrationDeclaresCapabilities(t *testing.T) {
	h := newTestHandler(t, nil)
	result, err := h.HandleMethod("plugin.register", []byte(`{"config_yaml":"`+base64Config(testConfigYAML)+`","schema_version":10}`))
	if err != nil {
		t.Fatalf("plugin.register error = %v", err)
	}
	var registration RegistrationResponse
	if err := json.Unmarshal(decodeOKEnvelope(t, result), &registration); err != nil {
		t.Fatalf("decode registration: %v", err)
	}
	if registration.SchemaVersion != 10 {
		t.Errorf("schema_version = %d, want 10", registration.SchemaVersion)
	}
	if !registration.Capabilities.AuthProvider || !registration.Capabilities.Executor {
		t.Errorf("capabilities missing auth/executor: %+v", registration.Capabilities)
	}
	if registration.Capabilities.ExecutorModelScope != "oauth" {
		t.Errorf("executor_model_scope = %q, want oauth (no static-only serving)", registration.Capabilities.ExecutorModelScope)
	}
	if registration.Metadata.Name == "" {
		t.Errorf("metadata name empty")
	}
}

func base64Config(config string) string {
	// encoding/json marshals []byte as base64; the lifecycle request carries
	// config_yaml in that wire form.
	encoded, _ := json.Marshal([]byte(config))
	return string(encoded[1 : len(encoded)-1])
}

// TestAuthIdentifierAndLoginBoundary pins the provider key and the explicit
// login refusal: a login here would create a second refresh owner, so both
// login methods fail closed with 501.
func TestAuthIdentifierAndLoginBoundary(t *testing.T) {
	h := newTestHandler(t, nil)
	result, err := h.HandleMethod("auth.identifier", nil)
	if err != nil {
		t.Fatalf("auth.identifier error = %v", err)
	}
	var identifier struct {
		Identifier string `json:"identifier"`
	}
	_ = json.Unmarshal(decodeOKEnvelope(t, result), &identifier)
	if identifier.Identifier != ProviderKey {
		t.Errorf("identifier = %q, want %q", identifier.Identifier, ProviderKey)
	}
	if _, err := h.HandleMethod("auth.login.start", nil); err == nil {
		t.Errorf("auth.login.start succeeded, want explicit refusal")
	} else if statusOf(err) != 501 {
		t.Errorf("auth.login.start status = %d, want 501", statusOf(err))
	}
	if _, err := h.HandleMethod("auth.login.poll", nil); err == nil {
		t.Errorf("auth.login.poll succeeded, want explicit refusal")
	}
	if _, err := h.HandleMethod("executor.count_tokens", nil); err == nil {
		t.Errorf("executor.count_tokens succeeded, want no fabricated counts")
	}
}

func statusOf(err error) int {
	if se, ok := AsStatusError(err); ok {
		return se.Status()
	}
	return 0
}

// TestAuthParseHandlesNativeCredential pins auth.parse: the native shape is
// handled with the provider key, a NextRefreshAfter at the native 5-minute
// lead, and foreign payloads are declined so other parsers run.
func TestAuthParseHandlesNativeCredential(t *testing.T) {
	h := newTestHandler(t, nil)
	request, _ := json.Marshal(map[string]any{
		"Provider": ProviderKey,
		"Path":     "/authdir/opencode.json",
		"FileName": "opencode.json",
		"RawJSON":  []byte(validCredential),
	})
	result, err := h.HandleMethod("auth.parse", request)
	if err != nil {
		t.Fatalf("auth.parse error = %v", err)
	}
	var parsed AuthParseResponse
	if err := json.Unmarshal(decodeOKEnvelope(t, result), &parsed); err != nil {
		t.Fatalf("decode auth.parse: %v", err)
	}
	if !parsed.Handled {
		t.Fatalf("auth.parse declined the native credential shape")
	}
	if parsed.Auth.Provider != ProviderKey {
		t.Errorf("provider = %q, want %q", parsed.Auth.Provider, ProviderKey)
	}
	if parsed.Auth.ID != "opencode:opencode.json" {
		t.Errorf("id = %q, want provider-namespaced file identity", parsed.Auth.ID)
	}
	if parsed.Auth.NextRefreshAfter.UnixMilli() != 2000000000000-DefaultRefreshBufferMs {
		t.Errorf("NextRefreshAfter = %d, want expiry minus the native 5min lead", parsed.Auth.NextRefreshAfter.UnixMilli())
	}
	// The persisted storage keeps the native shape (round-trips through the
	// plugin without transformation).
	var stored Credential
	if err := json.Unmarshal(parsed.Auth.StorageJSON, &stored); err != nil {
		t.Fatalf("storage json invalid: %v", err)
	}
	if stored.Refresh != "live-refresh-token" || stored.Type != "oauth" {
		t.Errorf("storage round-trip lost native fields: %+v", stored)
	}

	// Foreign payload: declined, not an error.
	foreign, _ := json.Marshal(map[string]any{
		"Provider": ProviderKey,
		"RawJSON":  []byte(`{"apiKey":"sk-x"}`),
	})
	result, err = h.HandleMethod("auth.parse", foreign)
	if err != nil {
		t.Fatalf("auth.parse(foreign) error = %v", err)
	}
	var declined AuthParseResponse
	_ = json.Unmarshal(decodeOKEnvelope(t, result), &declined)
	if declined.Handled {
		t.Errorf("auth.parse handled a foreign payload, want decline")
	}
}

// TestAuthRefreshPerformsNativeGrant pins the refresh port against the
// native opencode.ts refresh(): the request goes to
// {server}/auth/device/token as a JSON body with grant_type=refresh_token,
// refresh_token and client_id=opencode-cli; a 200 response rotates the
// credential with expiry now + expires_in*1000 and returns NextRefreshAfter
// at the native lead. Fake transport only; no network.
func TestAuthRefreshPerformsNativeGrant(t *testing.T) {
	transport := &fakeTransport{doResult: HTTPResult{
		StatusCode: 200,
		Body:       []byte(`{"access_token":"rotated-access","refresh_token":"rotated-refresh","expires_in":3600,"org_id":"org_1"}`),
	}}
	h := newTestHandler(t, transport)
	request, _ := json.Marshal(map[string]any{
		"AuthID":       "opencode",
		"AuthProvider": ProviderKey,
		"StorageJSON":  []byte(validCredential),
	})
	result, err := h.HandleMethod("auth.refresh", request)
	if err != nil {
		t.Fatalf("auth.refresh error = %v", err)
	}
	if len(transport.doCalls) != 1 {
		t.Fatalf("refresh calls = %d, want exactly one grant request", len(transport.doCalls))
	}
	call := transport.doCalls[0]
	if call.Method != "POST" || call.URL != "https://opencode.ai/console/auth/device/token" {
		t.Errorf("refresh call = %s %s, want POST to the native device token endpoint", call.Method, call.URL)
	}
	var grant map[string]string
	if err := json.Unmarshal(call.Body, &grant); err != nil {
		t.Fatalf("refresh body invalid: %v", err)
	}
	if grant["grant_type"] != "refresh_token" || grant["refresh_token"] != "live-refresh-token" || grant["client_id"] != ClientID {
		t.Errorf("refresh grant = %v, want the native grant fields", grant)
	}
	if !strings.Contains(strings.Join(call.Headers["user-agent"], ""), "opencode/") {
		t.Errorf("refresh user-agent missing native form: %v", call.Headers["user-agent"])
	}
	var refreshed AuthRefreshResponse
	if err := json.Unmarshal(decodeOKEnvelope(t, result), &refreshed); err != nil {
		t.Fatalf("decode auth.refresh: %v", err)
	}
	var stored Credential
	if err := json.Unmarshal(refreshed.Auth.StorageJSON, &stored); err != nil {
		t.Fatalf("rotated storage invalid: %v", err)
	}
	if stored.Access != "rotated-access" || stored.Refresh != "rotated-refresh" {
		t.Errorf("rotated tokens = %+v, want both replaced", stored)
	}
	if stored.Expiry() != testNow+3600*1000 {
		t.Errorf("rotated expiry = %d, want now + expires_in in ms", stored.Expiry())
	}
	if refreshed.NextRefreshAfter.UnixMilli() != stored.Expiry()-DefaultRefreshBufferMs {
		t.Errorf("NextRefreshAfter = %d, want the native lead", refreshed.NextRefreshAfter.UnixMilli())
	}
}

// TestAuthRefreshSignedOutIsTerminal pins the native SignedOut boundary: a
// 400 invalid_grant refresh is terminal (never retried, surfaced as 401 with
// the native signed-out message).
func TestAuthRefreshSignedOutIsTerminal(t *testing.T) {
	transport := &fakeTransport{doResult: HTTPResult{
		StatusCode: 400,
		Body:       []byte(`{"error":"invalid_grant"}`),
	}}
	h := newTestHandler(t, transport)
	request, _ := json.Marshal(map[string]any{
		"AuthID":       "opencode",
		"AuthProvider": ProviderKey,
		"StorageJSON":  []byte(validCredential),
	})
	_, err := h.HandleMethod("auth.refresh", request)
	if err == nil {
		t.Fatalf("auth.refresh(invalid_grant) succeeded, want terminal signed-out")
	}
	if !IsSignedOut(err) {
		t.Errorf("auth.refresh(invalid_grant) error is not SignedOut: %v", err)
	}
	if statusOf(err) != 401 {
		t.Errorf("signed-out status = %d, want 401", statusOf(err))
	}
	if len(transport.doCalls) != 1 {
		t.Errorf("refresh retried after invalid_grant: %d calls, want exactly one", len(transport.doCalls))
	}
}

// TestAuthRefreshOtherFailures pins non-grant refresh failures: a 401/403
// refresh is terminal signed-out per the native flow; a transport failure
// surfaces 502; no retry exists.
func TestAuthRefreshOtherFailures(t *testing.T) {
	transport := &fakeTransport{doResult: HTTPResult{StatusCode: 403, Body: []byte(`{"_tag":"SsoRequired"}`)}}
	h := newTestHandler(t, transport)
	request, _ := json.Marshal(map[string]any{
		"AuthID":       "opencode",
		"AuthProvider": ProviderKey,
		"StorageJSON":  []byte(validCredential),
	})
	_, err := h.HandleMethod("auth.refresh", request)
	if err == nil || statusOf(err) != 403 {
		t.Errorf("auth.refresh(403) = %v status %d, want the upstream status preserved", err, statusOf(err))
	}
	transport = &fakeTransport{doErr: fmt.Errorf("connection refused")}
	h = newTestHandler(t, transport)
	_, err = h.HandleMethod("auth.refresh", request)
	if err == nil || statusOf(err) != 502 {
		t.Errorf("auth.refresh(transport failure) status = %d, want 502", statusOf(err))
	}
}

// TestModelRegistration pins the catalog surface: model.register /
// model.for_auth publish the configured allowlist for a usable credential;
// model.for_auth fails closed for an unusable one.
func TestModelRegistration(t *testing.T) {
	h := newTestHandler(t, nil)
	result, err := h.HandleMethod("model.register", nil)
	if err != nil {
		t.Fatalf("model.register error = %v", err)
	}
	var models PluginModels
	if err := json.Unmarshal(decodeOKEnvelope(t, result), &models); err != nil {
		t.Fatalf("decode model.register: %v", err)
	}
	if models.Provider != ProviderKey {
		t.Errorf("provider = %q, want %q", models.Provider, ProviderKey)
	}
	if len(models.Models) != 2 {
		t.Fatalf("models = %d, want the two configured allowlist entries", len(models.Models))
	}
	if models.Models[0].ID != "beam-free" || models.Models[1].ID != "glm-5.3-flash-free" {
		t.Errorf("catalog ids = %+v, want configured order after sort", models.Models)
	}
	requestForAuth, _ := json.Marshal(map[string]any{
		"AuthID":       "opencode",
		"AuthProvider": ProviderKey,
		"StorageJSON":  []byte(validCredential),
	})
	result, err = h.HandleMethod("model.for_auth", requestForAuth)
	if err != nil {
		t.Fatalf("model.for_auth error = %v", err)
	}
	_ = json.Unmarshal(decodeOKEnvelope(t, result), &models)
	if len(models.Models) != 2 {
		t.Errorf("model.for_auth models = %d, want 2 for a usable credential", len(models.Models))
	}
	badCredential, _ := json.Marshal(map[string]any{
		"AuthID":       "opencode",
		"AuthProvider": ProviderKey,
		"StorageJSON":  []byte(`{"type":"key","key":"x"}`),
	})
	if _, err := h.HandleMethod("model.for_auth", badCredential); err == nil {
		t.Errorf("model.for_auth(unusable credential) succeeded, want fail-closed")
	}
}

// TestExecuteFailsClosedBeforeDispatch pins the admission order: disabled
// config, unconfigured endpoint, non-allowlisted model, unusable credential,
// expired access token and missing session identity all fail BEFORE any
// upstream call.
func TestExecuteFailsClosedBeforeDispatch(t *testing.T) {
	executorRequest := func(modifier func(map[string]any)) []byte {
		payload := map[string]any{
			"AuthID":       "opencode",
			"AuthProvider": ProviderKey,
			"Model":        "beam-free",
			"Stream":       false,
			"Payload":      []byte(`{"model":"beam-free","messages":[{"role":"user","content":"hi"}]}`),
			"StorageJSON":  []byte(validCredential),
			"Metadata":     map[string]any{"canonical_session_id": "ses_e6983cfa5ffejQiSHP0zl9KfzV"},
			"Headers":      map[string]any{},
		}
		if modifier != nil {
			modifier(payload)
		}
		raw, _ := json.Marshal(payload)
		return raw
	}

	// Disabled configuration.
	transport := &fakeTransport{}
	h := newTestHandler(t, transport)
	_ = h.Configure([]byte("enabled: false\ninference_base_url: https://opencode.ai/inference/openai/v1\nmodels: [beam-free]"))
	if _, err := h.HandleMethod("executor.execute", executorRequest(nil)); err == nil || statusOf(err) != 503 {
		t.Errorf("disabled execute = %v status %d, want 503", err, statusOf(err))
	}
	if len(transport.doCalls) != 0 {
		t.Errorf("disabled execute dispatched upstream: %d calls", len(transport.doCalls))
	}

	// No endpoint configured.
	h = newTestHandler(t, transport)
	_ = h.Configure([]byte("models: [beam-free]"))
	if _, err := h.HandleMethod("executor.execute", executorRequest(nil)); err == nil || statusOf(err) != 503 {
		t.Errorf("unconfigured execute = %v status %d, want 503", err, statusOf(err))
	}
	if len(transport.doCalls) != 0 {
		t.Errorf("unconfigured execute dispatched upstream: %d calls", len(transport.doCalls))
	}

	h = newTestHandler(t, transport)

	// Non-allowlisted model.
	if _, err := h.HandleMethod("executor.execute", executorRequest(func(p map[string]any) { p["Model"] = "gpt-4o" })); err == nil || statusOf(err) != 404 {
		t.Errorf("non-allowlisted model = %v status %d, want 404", err, statusOf(err))
	}
	if len(transport.doCalls) != 0 {
		t.Errorf("non-allowlisted model dispatched upstream")
	}

	// Unusable credential.
	if _, err := h.HandleMethod("executor.execute", executorRequest(func(p map[string]any) { p["StorageJSON"] = []byte(`{"type":"key","key":"x"}`) })); err == nil || statusOf(err) != 401 {
		t.Errorf("unusable credential = %v status %d, want 401", err, statusOf(err))
	}
	if len(transport.doCalls) != 0 {
		t.Errorf("unusable credential dispatched upstream")
	}

	// Expired access token: admitted BEFORE dispatch with a precise message
	// naming the single refresh owner requirement.
	_, err := h.HandleMethod("executor.execute", executorRequest(func(p map[string]any) {
		p["StorageJSON"] = []byte(`{"type":"oauth","methodID":"device","access":"old","refresh":"r","expires":999}`)
	}))
	if err == nil || statusOf(err) != 401 {
		t.Errorf("expired token = %v status %d, want 401 before dispatch", err, statusOf(err))
	}
	if len(transport.doCalls) != 0 {
		t.Errorf("expired token dispatched upstream: an expired token must fail locally, not burn an upstream 401")
	}
	if !strings.Contains(err.Error(), "refresh owner") {
		t.Errorf("expired-token message does not name the refresh owner requirement: %q", err.Error())
	}

	// A host canonical conversation id (foreign to the ses_ namespace) is
	// the registry's key: the request resolves a persistent provider session
	// and dispatches with the minted identity.
	doResult := transport.doResult
	transport.doResult = HTTPResult{StatusCode: 200, Body: []byte(fixtureTextSSE)}
	if _, err := h.HandleMethod("executor.execute", executorRequest(func(p map[string]any) {
		p["Metadata"] = map[string]any{"canonical_session_id": "0f4a6f1a-2b3c-4d5e-8f9a-1a2b3c4d5e6f"}
	})); err != nil {
		t.Errorf("registry-backed dispatch = %v, want success via a minted session id", err)
	}
	if len(transport.doCalls) != 1 {
		t.Errorf("registry-backed dispatch calls = %d, want one", len(transport.doCalls))
	} else {
		sent := transport.doCalls[0].Headers["x-opencode-session-id"][0]
		if !ValidSessionID(sent) {
			t.Errorf("registry-backed dispatch sent session id %q, want a native-shaped minted id", sent)
		}
	}
	transport.doResult = doResult

	// No conversation identity at all: the precise resolution gap, never a
	// guessed conversation key, and never an upstream call.
	if _, err := h.HandleMethod("executor.execute", executorRequest(func(p map[string]any) {
		p["Metadata"] = map[string]any{}
	})); err == nil || statusOf(err) != 422 {
		t.Errorf("no identity = %v status %d, want the conversation-identity gap (422)", err, statusOf(err))
	}
	if len(transport.doCalls) != 1 {
		t.Errorf("request with no identity dispatched upstream: %d calls", len(transport.doCalls))
	}
}

// TestExecuteDispatchesWithNativeHeaders pins the success path: one upstream
// POST to <base>/chat/completions with the native header set, the native
// body rules, and the response returned through the envelope.
func TestExecuteDispatchesWithNativeHeaders(t *testing.T) {
	transport := &fakeTransport{doResult: HTTPResult{
		StatusCode: 200,
		Headers:    map[string][]string{"content-type": {"text/event-stream"}},
		Body:       []byte(fixtureTextSSE),
	}}
	h := newTestHandler(t, transport)
	request, _ := json.Marshal(map[string]any{
		"AuthID":       "opencode",
		"AuthProvider": ProviderKey,
		"Model":        "beam-free",
		"Stream":       false,
		"Payload":      []byte(`{"model":"beam-free","messages":[{"role":"user","content":"hi"}],"max_tokens":64}`),
		"StorageJSON":  []byte(validCredential),
		"Metadata":     map[string]any{"canonical_session_id": "ses_e6983cfa5ffejQiSHP0zl9KfzV"},
	})
	result, err := h.HandleMethod("executor.execute", request)
	if err != nil {
		t.Fatalf("executor.execute error = %v", err)
	}
	if len(transport.doCalls) != 1 {
		t.Fatalf("upstream calls = %d, want exactly one dispatch", len(transport.doCalls))
	}
	call := transport.doCalls[0]
	if call.Method != "POST" || call.URL != "https://opencode.ai/inference/openai/v1/chat/completions" {
		t.Errorf("dispatch = %s %s, want POST to the native chat-completions path", call.Method, call.URL)
	}
	if call.Headers["authorization"][0] != "Bearer live-access-token" {
		t.Errorf("authorization = %v, want the OAuth bearer", call.Headers["authorization"])
	}
	if call.Headers["x-opencode-session-id"][0] != "ses_e6983cfa5ffejQiSHP0zl9KfzV" {
		t.Errorf("x-opencode-session-id = %v, want the caller's native session id", call.Headers["x-opencode-session-id"])
	}
	if call.Headers["x-session-affinity"][0] != "ses_e6983cfa5ffejQiSHP0zl9KfzV" {
		t.Errorf("x-session-affinity = %v, want the native affinity", call.Headers["x-session-affinity"])
	}
	if _, exists := call.Headers["x-org-id"]; exists {
		t.Errorf("inference dispatch sent x-org-id; native inference never carries the org header")
	}
	if _, exists := call.Headers["x-opencode-org-id"]; exists {
		t.Errorf("inference dispatch sent x-opencode-org-id; not a native inference header")
	}
	var body map[string]json.RawMessage
	if err := json.Unmarshal(call.Body, &body); err != nil {
		t.Fatalf("dispatch body invalid: %v", err)
	}
	if string(body["stream"]) != "true" {
		t.Errorf("dispatch stream = %s, want forced true", body["stream"])
	}
	var response ExecutorResponse
	if err := json.Unmarshal(decodeOKEnvelope(t, result), &response); err != nil {
		t.Fatalf("decode executor response: %v", err)
	}
	var completion struct {
		Object  string
		Choices []struct {
			Message struct{ Role, Content string }
		}
	}
	if err := json.Unmarshal(response.Payload, &completion); err != nil || completion.Object != "chat.completion" || completion.Choices[0].Message.Role != "assistant" || completion.Choices[0].Message.Content != "hi" {
		t.Errorf("invalid buffered completion: %s (%v)", response.Payload, err)
	}
}

// TestExecutePreservesRejection pins that a terminal upstream rejection
// converts to the structured error carrying the upstream status, native
// error code and retry-after — the host records cooldown from it.
func TestExecutePreservesRejection(t *testing.T) {
	transport := &fakeTransport{doResult: HTTPResult{
		StatusCode: 429,
		Headers:    map[string][]string{"retry-after": {"7200"}, "x-opencode-log-id": {"01a19696-b57a-7399-bbb8-67cd26f7721d"}},
		Body:       []byte(`{"type":"error","error":{"type":"FreeUsageLimitError","message":"Rate limit exceeded."}}`),
	}}
	h := newTestHandler(t, transport)
	request, _ := json.Marshal(map[string]any{
		"AuthID":       "opencode",
		"AuthProvider": ProviderKey,
		"Model":        "beam-free",
		"Payload":      []byte(`{"model":"beam-free","messages":[{"role":"user","content":"hi"}]}`),
		"StorageJSON":  []byte(validCredential),
		"Metadata":     map[string]any{"canonical_session_id": "ses_e6983cfa5ffejQiSHP0zl9KfzV"},
	})
	_, err := h.HandleMethod("executor.execute", request)
	if err == nil {
		t.Fatalf("execute(429) succeeded, want the rejection")
	}
	statusErr, ok := AsStatusError(err)
	if !ok {
		t.Fatalf("execute(429) error is not a status error: %v", err)
	}
	if statusErr.Status() != 429 {
		t.Errorf("rejection status = %d, want 429 preserved", statusErr.Status())
	}
	if statusErr.Code() != "provider.free-limit" {
		t.Errorf("rejection code = %q, want provider.free-limit", statusErr.Code())
	}
	if statusErr.RetryAfterSeconds() != 7200 {
		t.Errorf("rejection retry-after = %d, want 7200", statusErr.RetryAfterSeconds())
	}
	if len(transport.doCalls) != 1 {
		t.Errorf("rejection retried upstream: %d calls, want one", len(transport.doCalls))
	}
}

// TestExecuteStreamRelaysAndClosesOnError pins the streaming path: chunks
// relay through the emitter, a rejection closes the plugin stream with the
// structured error detail, and the host is acknowledged immediately.
func TestExecuteStreamRelaysAndClosesOnError(t *testing.T) {
	var relayMu sync.Mutex
	var emitted [][]byte
	var closed []error
	StreamEmitter = func(streamID string, payload []byte) error {
		if streamID != "stream-1" {
			t.Errorf("emit stream id = %q, want stream-1", streamID)
		}
		relayMu.Lock()
		emitted = append(emitted, payload)
		relayMu.Unlock()
		return nil
	}
	StreamCloser = func(streamID string, err error) {
		relayMu.Lock()
		closed = append(closed, err)
		relayMu.Unlock()
	}
	t.Cleanup(func() {
		StreamEmitter = nil
		StreamCloser = nil
	})

	chunks := make(chan StreamChunk, 2)
	chunks <- StreamChunk{Payload: []byte(fixtureTextSSE)}
	close(chunks)
	transport := &fakeTransport{streamResult: StreamResult{
		StatusCode: 200,
		Headers:    map[string][]string{"content-type": {"text/event-stream"}},
		Chunks:     chunks,
	}}
	h := newTestHandler(t, transport)
	request, _ := json.Marshal(map[string]any{
		"AuthID":       "opencode",
		"AuthProvider": ProviderKey,
		"Model":        "beam-free",
		"Stream":       true,
		"Payload":      []byte(`{"model":"beam-free","messages":[{"role":"user","content":"hi"}]}`),
		"StorageJSON":  []byte(validCredential),
		"Metadata":     map[string]any{"canonical_session_id": "ses_e6983cfa5ffejQiSHP0zl9KfzV"},
		"stream_id":    "stream-1",
	})
	if _, err := h.HandleMethod("executor.execute_stream", request); err != nil {
		t.Fatalf("executor.execute_stream error = %v", err)
	}
	// The relay runs asynchronously; wait for it to drain with a bounded
	// deadline.
	relayMu.Lock()
	emittedCount, closedCount := len(emitted), len(closed)
	relayMu.Unlock()
	waitFor(t, func() bool {
		relayMu.Lock()
		defer relayMu.Unlock()
		return len(emitted) == 2 && len(closed) == 1
	})
	relayMu.Lock()
	emittedCount, closedCount = len(emitted), len(closed)
	relayMu.Unlock()
	if emittedCount != 2 {
		t.Fatalf("emitted chunks = %d, want 2 relayed frames", emittedCount)
	}
	if closedCount != 1 || closed[0] != nil {
		t.Errorf("stream success requires one nil-error close: %d closes", closedCount)
	}

	// Upstream stream failure closes the plugin stream with the error.
	chunks = make(chan StreamChunk, 1)
	chunks <- StreamChunk{Err: fmt.Errorf("upstream broke")}
	close(chunks)
	transport = &fakeTransport{streamResult: StreamResult{StatusCode: 200, Chunks: chunks}}
	h = newTestHandler(t, transport)
	relayMu.Lock()
	emitted = nil
	closed = nil
	relayMu.Unlock()
	if _, err := h.HandleMethod("executor.execute_stream", request); err != nil {
		t.Fatalf("executor.execute_stream(open failure) error = %v", err)
	}
	waitFor(t, func() bool {
		relayMu.Lock()
		defer relayMu.Unlock()
		return len(closed) == 1
	})
	relayMu.Lock()
	closedCount = len(closed)
	relayMu.Unlock()
	if closedCount != 1 {
		t.Fatalf("stream error close count = %d, want one error close", closedCount)
	}

	// Rejection status closes with the structured detail.
	transport = &fakeTransport{streamResult: StreamResult{
		StatusCode: 429,
		Headers:    map[string][]string{"retry-after": {"600"}},
	}}
	h = newTestHandler(t, transport)
	relayMu.Lock()
	emitted = nil
	closed = nil
	relayMu.Unlock()
	_, err := h.HandleMethod("executor.execute_stream", request)
	if err == nil {
		t.Fatalf("execute_stream(429) succeeded, want the rejection error")
	}
	statusErr, ok := AsStatusError(err)
	if !ok || statusErr.Status() != 429 {
		t.Fatalf("execute_stream(429) status = %d, want 429", statusErr.Status())
	}
	if len(transport.doStreamCalls) != 1 {
		t.Errorf("stream rejection retried upstream: %d calls", len(transport.doStreamCalls))
	}
}

// waitFor polls cond until it holds or a two-second bounded deadline passes.
func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(2 * time.Millisecond)
	}
}

// TestExecutorHTTPRequestBridgesConsoleGETOnly pins the bounded HTTP
// passthrough: GET-only, limited to the credential's Console server, with
// the native Console headers (x-org-id where the credential records an org).
func TestExecutorHTTPRequestBridgesConsoleGETOnly(t *testing.T) {
	transport := &fakeTransport{doResult: HTTPResult{
		StatusCode: 200,
		Body:       []byte(`{"providers":{}}`),
	}}
	h := newTestHandler(t, transport)
	request, _ := json.Marshal(map[string]any{
		"Method":      "GET",
		"URL":         "https://opencode.ai/console/api/v2/config",
		"StorageJSON": []byte(validCredential),
		"Headers":     map[string][]string{"accept": {"application/json"}},
	})
	result, err := h.HandleMethod("executor.http_request", request)
	if err != nil {
		t.Fatalf("executor.http_request error = %v", err)
	}
	if len(transport.doCalls) != 1 {
		t.Fatalf("console calls = %d, want one", len(transport.doCalls))
	}
	call := transport.doCalls[0]
	if call.Headers["x-org-id"][0] != "org_1" {
		t.Errorf("console GET x-org-id = %v, want the credential org (Console API calls carry it)", call.Headers["x-org-id"])
	}
	if call.Headers["authorization"][0] != "Bearer live-access-token" {
		t.Errorf("console GET authorization = %v", call.Headers["authorization"])
	}
	var response struct {
		StatusCode int    `json:"StatusCode"`
		Body       []byte `json:"Body"`
	}
	_ = json.Unmarshal(decodeOKEnvelope(t, result), &response)
	if response.StatusCode != 200 {
		t.Errorf("console response status = %d, want 200", response.StatusCode)
	}

	// POST is refused.
	postRequest, _ := json.Marshal(map[string]any{
		"Method":      "POST",
		"URL":         "https://opencode.ai/console/api/v2/config",
		"StorageJSON": []byte(validCredential),
	})
	if _, err := h.HandleMethod("executor.http_request", postRequest); err == nil || statusOf(err) != 501 {
		t.Errorf("console POST = %v status %d, want refusal", err, statusOf(err))
	}

	// A URL outside the credential's Console server is refused.
	foreignRequest, _ := json.Marshal(map[string]any{
		"Method":      "GET",
		"URL":         "https://evil.example/api",
		"StorageJSON": []byte(validCredential),
	})
	if _, err := h.HandleMethod("executor.http_request", foreignRequest); err == nil || statusOf(err) != 403 {
		t.Errorf("foreign console URL = %v status %d, want refusal", err, statusOf(err))
	}
}

// TestSessionIdentityFromHeaders pins that a caller's native session id in
// the request headers is honored (x-opencode-session-id first), matching the
// operator-declared identity path.
func TestSessionIdentityFromHeaders(t *testing.T) {
	headers := map[string][]string{
		"x-opencode-session-id": {"ses_e6983cfa5ffejQiSHP0zl9KfzV"},
	}
	if got := sessionIDFromHeaders(headers); got != "ses_e6983cfa5ffejQiSHP0zl9KfzV" {
		t.Errorf("sessionIDFromHeaders = %q, want the native id", got)
	}
	foreign := map[string][]string{
		"x-session-id":       {"0f4a6f1a-2b3c-4d5e-8f9a-1a2b3c4d5e6f"},
		"x-session-affinity": {"affinity:xyz"},
	}
	if got := sessionIDFromHeaders(foreign); got != "" {
		t.Errorf("sessionIDFromHeaders(foreign) = %q, want rejected (not a native shape)", got)
	}
}
