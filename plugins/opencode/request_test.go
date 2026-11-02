package opencode

import (
	"encoding/json"
	"reflect"
	"testing"
)

// TestInferenceHeadersMatchNative pins the exact native inference header set
// from packages/core/src/session/model-request.ts (2.0.32/2.1.4/2.2.5 are
// identical here):
//
//	"x-opencode-session-id": session.id,
//	"x-session-affinity": affinity,
//	"X-Session-Id": affinity,
//	"x-opencode-session": affinity,
//	"User-Agent": App.useragent(app),
//	"x-opencode-project": session.projectID,
//	"x-opencode-client": app.name,
//
// The rejected candidate injected an x-opencode-org-id header and a
// configurable "client_version" user agent; the native set has neither, and
// this BASE header block excludes provider overlays; Console may separately
// supply x-opencode-org-id. x-org-id is Console-API-only.
func TestInferenceHeadersMatchNative(t *testing.T) {
	app := AppInfo{Name: "cli", Version: "2.0.32", Channel: "latest"}
	headers := InferenceHeaders(app, "ses_e6983cfa5ffejQiSHP0zl9KfzV", "ses_e6983cfa5ffejQiSHP0zl9KfzV", "prj_1", "Bearer token")
	want := map[string][]string{
		"authorization":         {"Bearer token"},
		"user-agent":            {"opencode/latest/2.0.32/cli"},
		"x-opencode-session-id": {"ses_e6983cfa5ffejQiSHP0zl9KfzV"},
		"x-session-affinity":    {"ses_e6983cfa5ffejQiSHP0zl9KfzV"},
		"X-Session-Id":          {"ses_e6983cfa5ffejQiSHP0zl9KfzV"},
		"x-opencode-session":    {"ses_e6983cfa5ffejQiSHP0zl9KfzV"},
		"x-opencode-project":    {"prj_1"},
		"x-opencode-client":     {"cli"},
		"content-type":          {"application/json"},
		"accept":                {"text/event-stream"},
	}
	if !reflect.DeepEqual(headers, want) {
		t.Errorf("InferenceHeaders mismatch:\n got  %v\n want %v", headers, want)
	}
	for _, forbidden := range []string{"x-org-id", "x-opencode-org-id", "cookie"} {
		if _, exists := headers[forbidden]; exists {
			t.Errorf("inference headers contain %q; base session header block must exclude provider overlays", forbidden)
		}
	}
}

// TestUserAgentMatchesNativeApp pins the native App.useragent format
// (app.ts: `opencode/${channel}/${version}/${name}`) with the artifact name.
func TestUserAgentMatchesNativeApp(t *testing.T) {
	cases := []struct {
		app  AppInfo
		want string
	}{
		{AppInfo{Name: "cli", Version: "2.0.32", Channel: "latest"}, "opencode/latest/2.0.32/cli"},
		{AppInfo{Name: "cli", Version: "2.1.4", Channel: "latest"}, "opencode/latest/2.1.4/cli"},
		{AppInfo{Name: "cli", Version: "2.2.5", Channel: "prod"}, "opencode/prod/2.2.5/cli"},
		{AppInfo{Name: "cli", Version: "2.2.5", Channel: "beta"}, "opencode/beta/2.2.5/cli"},
	}
	for _, tc := range cases {
		if got := UserAgent(tc.app); got != tc.want {
			t.Errorf("UserAgent(%+v) = %q, want %q", tc.app, got, tc.want)
		}
	}
}

// TestInferenceHeadersAffinityFallback pins the native SessionAffinity.get
// rule (affinity.ts: parentID ?? fork?.sessionID ?? id) in its simplest
// callable form: when the caller supplies no affinity, the session id is the
// affinity (a session with no parent/fork is its own affinity root).
func TestInferenceHeadersAffinityFallback(t *testing.T) {
	app := DefaultAppInfo()
	headers := InferenceHeaders(app, "ses_e6983cfa5ffejQiSHP0zl9KfzV", "", "", "Bearer t")
	if got := headers["x-session-affinity"][0]; got != "ses_e6983cfa5ffejQiSHP0zl9KfzV" {
		t.Errorf("affinity fallback = %q, want the session id", got)
	}
	if got := headers["x-opencode-project"][0]; got != "global" {
		t.Errorf("project fallback = %q, want the native global project identity", got)
	}
}

// TestShapeInferenceRequestMatchesNative pins the native body compilation
// rules from openai-chat.ts fromRequest() applied to an OpenAI chat payload:
// stream is forced to true (Schema.Literal(true)), stream_options.
// include_usage defaults on (streamUsage ?? true), model is rewritten to the
// bare upstream id, and every caller field is preserved untouched.
func TestShapeInferenceRequestMatchesNative(t *testing.T) {
	payload := []byte(`{
      "model": "opencode/beam-free",
      "messages": [{"role":"user","content":[{"type":"text","text":"hi"}]}],
      "tools": [{"type":"function","function":{"name":"lookup","description":"d","parameters":{"type":"object"}}}],
      "tool_choice": "auto",
      "max_tokens": 128,
      "temperature": 0.2,
      "reasoning_effort": "low"
    }`)
	shaped, err := shapeInferenceRequest(payload, "beam-free")
	if err != nil {
		t.Fatalf("shapeInferenceRequest error = %v", err)
	}
	var body map[string]json.RawMessage
	if err := json.Unmarshal(shaped, &body); err != nil {
		t.Fatalf("shaped body invalid: %v", err)
	}
	if string(body["stream"]) != "true" {
		t.Errorf("stream = %s, want forced true (native Schema.Literal(true))", body["stream"])
	}
	if string(body["model"]) != `"beam-free"` {
		t.Errorf("model = %s, want bare upstream id", body["model"])
	}
	var streamOptions struct {
		IncludeUsage bool `json:"include_usage"`
	}
	_ = json.Unmarshal(body["stream_options"], &streamOptions)
	if !streamOptions.IncludeUsage {
		t.Errorf("stream_options.include_usage = false, want default true")
	}
	// Caller semantics preserved byte-for-byte.
	for _, key := range []string{"messages", "tools", "tool_choice", "max_tokens", "temperature", "reasoning_effort"} {
		if _, exists := body[key]; !exists {
			t.Errorf("caller field %q was dropped; native compilation preserves it", key)
		}
	}
	// Explicit caller stream_options is respected, not overwritten.
	payloadExplicit := []byte(`{"model":"m","stream_options":{"include_usage":false}}`)
	shapedExplicit, err := shapeInferenceRequest(payloadExplicit, "m")
	if err != nil {
		t.Fatalf("shapeInferenceRequest(explicit stream_options) error = %v", err)
	}
	var explicit map[string]json.RawMessage
	_ = json.Unmarshal(shapedExplicit, &explicit)
	if string(explicit["stream_options"]) != `{"include_usage":false}` {
		t.Errorf("explicit stream_options overwritten: %s", explicit["stream_options"])
	}
	// Session identity never rides in the body.
	payloadSession := []byte(`{"model":"m","session":"ses_e6983cfa5ffejQiSHP0zl9KfzV","session_id":"other"}`)
	shapedSession, err := shapeInferenceRequest(payloadSession, "m")
	if err != nil {
		t.Fatalf("shapeInferenceRequest(session body) error = %v", err)
	}
	if string(shapedSession) == "" {
		t.Fatal("shaped session payload empty")
	}
	var withSession map[string]json.RawMessage
	_ = json.Unmarshal(shapedSession, &withSession)
	for _, forbidden := range []string{"session", "session_id"} {
		if _, exists := withSession[forbidden]; exists {
			t.Errorf("session identity leaked into body field %q; it is header-only", forbidden)
		}
	}
}

// TestShapeInferenceRequestNeverInjectsTools pins the no-fake-tools rule:
// a request with no tools gains none, and a strict-mode tool keeps its
// caller-provided strict value (the native compiler only adds strict:false
// where supportsStrictMode, and never invents tools).
func TestShapeInferenceRequestNeverInjectsTools(t *testing.T) {
	noTools := []byte(`{"model":"m","messages":[{"role":"user","content":"hi"}]}`)
	shaped, err := shapeInferenceRequest(noTools, "m")
	if err != nil {
		t.Fatalf("shapeInferenceRequest(no tools) error = %v", err)
	}
	var body map[string]json.RawMessage
	_ = json.Unmarshal(shaped, &body)
	if _, exists := body["tools"]; exists {
		t.Errorf("tools injected into a tool-free request; the plugin never fabricates tools")
	}
	strict := []byte(`{"model":"m","tools":[{"type":"function","function":{"name":"x","strict":true,"parameters":{}}}],"messages":[]}`)
	shapedStrict, err := shapeInferenceRequest(strict, "m")
	if err != nil {
		t.Fatalf("shapeInferenceRequest(strict tool) error = %v", err)
	}
	var strictBody struct {
		Tools []struct {
			Function struct {
				Strict bool `json:"strict"`
			} `json:"function"`
		} `json:"tools"`
	}
	_ = json.Unmarshal(shapedStrict, &strictBody)
	if len(strictBody.Tools) != 1 || strictBody.Tools[0].Function.Strict != true {
		t.Errorf("caller strict value not preserved: %+v", strictBody.Tools)
	}
}

// TestInferenceEndpoint pins the endpoint join and its validation.
func TestInferenceEndpoint(t *testing.T) {
	endpoint, err := InferenceEndpoint("https://opencode.ai/inference/openai/v1")
	if err != nil {
		t.Fatalf("InferenceEndpoint error = %v", err)
	}
	if endpoint != "https://opencode.ai/inference/openai/v1/chat/completions" {
		t.Errorf("endpoint = %q, want the native catalog root + /chat/completions", endpoint)
	}
	if endpoint, err = InferenceEndpoint("https://x.example/v1/"); err != nil || endpoint != "https://x.example/v1/chat/completions" {
		t.Errorf("trailing slash not trimmed: %q %v", endpoint, err)
	}
	for _, raw := range []string{"", "  ", "not-a-url", "ftp://x/y"} {
		if _, err := InferenceEndpoint(raw); err == nil {
			t.Errorf("InferenceEndpoint(%q) succeeded, want validation error", raw)
		}
	}
}

// TestUpstreamModelID pins the bare-id mapping: the native catalog serves
// unprefixed ids; a public opencode/ prefix is stripped, bare ids pass.
func TestUpstreamModelID(t *testing.T) {
	cases := map[string]string{
		"beam-free":                   "beam-free",
		"opencode/beam-free":          "beam-free",
		"OPENCODE/glm-5.3-flash-free": "glm-5.3-flash-free",
		"  opencode/big-pickle  ":     "big-pickle",
	}
	for in, want := range cases {
		if got := UpstreamModelID(in); got != want {
			t.Errorf("UpstreamModelID(%q) = %q, want %q", in, got, want)
		}
	}
}
