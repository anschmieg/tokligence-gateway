package opencode

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestHandlerScopesNativeLookingConversationsAndIgnoresCredentialRotation(t *testing.T) {
	transport := &fakeTransport{doResult: HTTPResult{StatusCode: 200, Body: []byte(fixtureTextSSE)}}
	h := newTestHandler(t, transport)
	request := func(scope, authID string) []byte {
		var req map[string]any
		_ = json.Unmarshal(configLifecycleRequest(false), &req)
		req["AuthID"] = authID
		req["Metadata"] = map[string]any{"caller_scope": scope, "canonical_session_id": "ses_e6983cfa5ffejQiSHP0zl9KfzV"}
		req["Headers"] = map[string][]string{"Authorization": {"Bearer ignored-client-header"}, "x-opencode-session-id": {"ses_e6983cfa5ffejQiSHP0zl9KfzV"}}
		raw, _ := json.Marshal(req)
		return raw
	}
	for _, pair := range [][2]string{{fixtureCallerScope, "upstream-a"}, {fixtureCallerScope, "upstream-b"}, {strings.Repeat("b", 64), "upstream-a"}} {
		if _, err := h.HandleMethod("executor.execute", request(pair[0], pair[1])); err != nil {
			t.Fatal(err)
		}
	}
	first := transport.doCalls[0].Headers["x-opencode-session-id"][0]
	second := transport.doCalls[1].Headers["x-opencode-session-id"][0]
	other := transport.doCalls[2].Headers["x-opencode-session-id"][0]
	if !ValidSessionID(first) || first != second || first == other || first == "ses_e6983cfa5ffejQiSHP0zl9KfzV" {
		t.Fatal("scope isolation or credential-independent continuity failed")
	}
	if h.registry.Stats().Entries != 2 || h.registry.Stats().Active != 0 {
		t.Fatal("registry bypassed or lease leaked")
	}
}

func TestHandlerRejectsMissingOrMalformedHostScopeBeforeHTTP(t *testing.T) {
	transport := &fakeTransport{}
	h := newTestHandler(t, transport)
	for _, scope := range []any{nil, "", "upstream-a", strings.Repeat("G", 64), 123} {
		var req map[string]any
		_ = json.Unmarshal(configLifecycleRequest(false), &req)
		req["Metadata"] = map[string]any{"caller_scope": scope, "canonical_session_id": "ses_e6983cfa5ffejQiSHP0zl9KfzV"}
		req["Headers"] = map[string][]string{"authorization": {"Bearer must-not-authorize-registry"}, "x-opencode-session-id": {"ses_e6983cfa5ffejQiSHP0zl9KfzV"}}
		raw, _ := json.Marshal(req)
		if _, err := h.HandleMethod("executor.execute", raw); statusOf(err) != 422 {
			t.Fatalf("invalid host scope accepted: %v", err)
		}
	}
	if len(transport.doCalls) != 0 || h.registry.Stats().Entries != 0 {
		t.Fatal("unscoped request reached state or transport")
	}
}
