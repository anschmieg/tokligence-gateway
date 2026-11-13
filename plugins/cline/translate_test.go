package cline

import (
	"encoding/json"
	"testing"
)

func TestPublicModelIDPrefixing(t *testing.T) {
	cases := map[string]string{
		"gpt-x":       "cline/gpt-x",
		"cline/gpt-x": "cline/gpt-x",
		"CLINE/gpt-x": "cline/gpt-x",
		"  gpt-x  ":   "cline/gpt-x",
	}
	for input, expected := range cases {
		if got := PublicModelID(input); got != expected {
			t.Errorf("PublicModelID(%q) = %q, want %q", input, got, expected)
		}
	}
	if PublicModelID("") != "" {
		t.Error("empty id should stay empty")
	}
}

func TestUpstreamModelIDStripsPrefix(t *testing.T) {
	cases := map[string]string{
		"cline/gpt-x": "gpt-x",
		"CLINE/gpt-x": "gpt-x",
		"gpt-x":       "gpt-x",
		"cline/":      "",
	}
	for input, expected := range cases {
		if got := UpstreamModelID(input); got != expected {
			t.Errorf("UpstreamModelID(%q) = %q, want %q", input, got, expected)
		}
	}
}

func TestTranslateChatRequestFloorsMaxTokens(t *testing.T) {
	payload := []byte(`{"model":"cline/gpt-x","messages":[{"role":"user","content":"hi"}],"max_tokens":8}`)
	translated, upstream, err := TranslateChatRequest("cline/gpt-x", payload)
	if err != nil {
		t.Fatalf("TranslateChatRequest: %v", err)
	}
	if upstream != "gpt-x" {
		t.Fatalf("upstream model = %q", upstream)
	}
	var body map[string]any
	if err := json.Unmarshal(translated, &body); err != nil {
		t.Fatalf("translated body: %v", err)
	}
	if body["model"] != "gpt-x" {
		t.Fatalf("model = %v", body["model"])
	}
	if body["max_tokens"] != float64(MinTokenFloor) {
		t.Fatalf("max_tokens = %v, want floor %d", body["max_tokens"], MinTokenFloor)
	}
}

func TestTranslateChatRequestPreservesLargeMaxTokens(t *testing.T) {
	payload := []byte(`{"model":"cline/gpt-x","messages":[],"max_completion_tokens":1200}`)
	translated, _, err := TranslateChatRequest("cline/gpt-x", payload)
	if err != nil {
		t.Fatalf("TranslateChatRequest: %v", err)
	}
	var body map[string]any
	if err := json.Unmarshal(translated, &body); err != nil {
		t.Fatalf("translated body: %v", err)
	}
	if body["max_completion_tokens"] != float64(1200) {
		t.Fatalf("max_completion_tokens = %v", body["max_completion_tokens"])
	}
}

func TestTranslateChatRequestPreservesUnknownFields(t *testing.T) {
	payload := []byte(`{"model":"cline/gpt-x","messages":[],"temperature":0.3,"tool_choice":"auto","future_field":{"nested":true}}`)
	translated, _, err := TranslateChatRequest("cline/gpt-x", payload)
	if err != nil {
		t.Fatalf("TranslateChatRequest: %v", err)
	}
	var body map[string]any
	if err := json.Unmarshal(translated, &body); err != nil {
		t.Fatalf("translated body: %v", err)
	}
	if body["temperature"] != 0.3 || body["tool_choice"] != "auto" {
		t.Fatalf("known fields lost: %v", body)
	}
	future, ok := body["future_field"].(map[string]any)
	if !ok || future["nested"] != true {
		t.Fatalf("unknown field lost: %v", body["future_field"])
	}
}

func TestTranslateChatRequestRejectsNonClineModel(t *testing.T) {
	if _, _, err := TranslateChatRequest("gpt-x", []byte(`{"model":"gpt-x"}`)); err == nil {
		t.Fatal("expected rejection of non-cline model")
	}
	if _, _, err := TranslateChatRequest("cline/has spaces", []byte(`{}`)); err == nil {
		t.Fatal("expected rejection of malformed model")
	}
	if _, _, err := TranslateChatRequest("", []byte(`{}`)); err == nil {
		t.Fatal("expected rejection of empty model")
	}
}

func TestClassifyUpstreamErrorTaxonomy(t *testing.T) {
	cases := []struct {
		status int
		body   string
		code   string
	}{
		{401, `{"error":"unauthorized"}`, "cline_auth_error"},
		{403, `{"error":"forbidden"}`, "cline_auth_error"},
		{429, `{"message":"free limit reached on model gpt-x"}`, "cline_daily_free_quota_exhausted"},
		{404, `{"error":"model not found"}`, "cline_model_retired"},
		{402, `{"error":"payment"}`, "cline_request_rejected"},
		{500, ``, "cline_upstream_error"},
		{429, `unrelated`, "cline_upstream_error"},
		{99, ``, "cline_upstream_error"}, // out of range falls back to 502
	}
	for _, tc := range cases {
		got := ClassifyUpstreamError(tc.status, []byte(tc.body))
		if got.Code != tc.code {
			t.Errorf("ClassifyUpstreamError(%d, %q) code = %q, want %q", tc.status, tc.body, got.Code, tc.code)
		}
	}
	auth := ClassifyUpstreamError(401, nil)
	if auth.StatusCode != 401 {
		t.Errorf("auth error status = %d", auth.StatusCode)
	}
	fallback := ClassifyUpstreamError(99, nil)
	if fallback.StatusCode != 502 {
		t.Errorf("out-of-range status should normalize to 502, got %d", fallback.StatusCode)
	}
}

func TestAuthorizationHeaderWorkosPrefix(t *testing.T) {
	if got := AuthorizationHeader("at"); got != "Bearer workos:at" {
		t.Fatalf("AuthorizationHeader(at) = %q", got)
	}
	if got := AuthorizationHeader("workos:at"); got != "Bearer workos:at" {
		t.Fatalf("AuthorizationHeader(workos:at) = %q", got)
	}
}

func TestRequestHeadersShape(t *testing.T) {
	headers := RequestHeaders("")
	if headers["X-CLIENT-TYPE"][0] != "cline-sdk" {
		t.Fatalf("client type = %v", headers["X-CLIENT-TYPE"])
	}
	if len(headers["X-Task-ID"]) != 1 || headers["X-Task-ID"][0] == "" {
		t.Fatalf("task id header = %v", headers["X-Task-ID"])
	}
}
