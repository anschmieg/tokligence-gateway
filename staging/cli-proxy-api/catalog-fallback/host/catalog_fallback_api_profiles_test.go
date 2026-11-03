package api

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestProfileHTTPUsesNativeAuthAndRejectsUnexpectedSurface(t *testing.T) {
	s := newTestServer(t)
	for _, path := range []string{"/coding/v1/models", "/coding/v1/chat/completions", "/coding/v1/messages", "/coding/v1/responses"} {
		method := "GET"
		if !strings.HasSuffix(path, "models") {
			method = "POST"
		}
		req := httptest.NewRequest(method, path, strings.NewReader(`{"model":"auto","messages":[]}`))
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		s.engine.ServeHTTP(rec, req)
		if rec.Code != 401 {
			t.Fatalf("%s status=%d body=%s", path, rec.Code, rec.Body.String())
		}
	}
	for _, path := range []string{"/coding/v1/models", "/unknown/v1/models", "/coding/v1/images/generations", "/coding/v1/messages/count_tokens", "/coding/v8/management/config"} {
		req := httptest.NewRequest(http.MethodGet, path, nil)
		req.Header.Set("Authorization", "Bearer test-key")
		rec := httptest.NewRecorder()
		s.engine.ServeHTTP(rec, req)
		if path == "/coding/v1/models" {
			if rec.Code != 503 {
				t.Fatal(rec.Code, rec.Body.String())
			}
		} else if rec.Code != 404 {
			t.Fatalf("unexpected surface %s: %d", path, rec.Code)
		}
	}
}

func TestProfileAndFullHTTPRejectAmbiguousModelBeforeResolution(t *testing.T) {
	s := newTestServer(t)
	for _, path := range []string{"/coding/v1/chat/completions", "/v1/chat/completions"} {
		req := httptest.NewRequest("POST", path, strings.NewReader(`{"model":"first","model":"second","messages":[]}`))
		req.Header.Set("Authorization", "Bearer test-key")
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		s.engine.ServeHTTP(rec, req)
		if rec.Code != 400 || !strings.Contains(rec.Body.String(), "ambiguous") {
			t.Fatal(path, rec.Code, rec.Body.String())
		}
	}
}
