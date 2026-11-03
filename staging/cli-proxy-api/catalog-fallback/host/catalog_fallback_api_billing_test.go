package api

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestSessionControlUsesNativeIdentityAndValidatesScope(t *testing.T) {
	s := newTestServer(t)
	call := func(method, path, session, key, body string) (int, map[string]any) {
		t.Helper()
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		req.Header.Set("X-Gateway-Session", session)
		if key != "" {
			req.Header.Set("Authorization", "Bearer "+key)
		}
		rec := httptest.NewRecorder()
		s.engine.ServeHTTP(rec, req)
		v := map[string]any{}
		json.Unmarshal(rec.Body.Bytes(), &v)
		return rec.Code, v
	}
	if code, _ := call("GET", "/v1/routing/session", "s", "", ""); code != 401 {
		t.Fatal(code)
	}
	if code, _ := call("GET", "/v1/routing/session", "", "test-key", ""); code != 400 {
		t.Fatal(code)
	}
	if code, v := call("GET", "/v1/routing/session", "s", "test-key", ""); code != 200 || v["policy"] != "SUB" {
		t.Fatal(code, v)
	}
	if code, v := call("PUT", "/v1/routing/session", "s", "test-key", `{"policy":"PAID"}`); code != 200 || v["policy"] != "PAID" {
		t.Fatal(code, v)
	}
	if code, v := call("GET", "/v1/routing/session", "s2", "test-key", ""); code != 200 || v["policy"] != "SUB" {
		t.Fatal(code, v)
	}
	for _, body := range []string{`{"policy":"PAID","policy":"FREE"}`, `{"policy":"INVALID"}`, `{"policy":"PAID","extra":true}`} {
		if code, _ := call("PUT", "/v1/routing/session", "s", "test-key", body); code != 400 {
			t.Fatal(body, code)
		}
	}
}
