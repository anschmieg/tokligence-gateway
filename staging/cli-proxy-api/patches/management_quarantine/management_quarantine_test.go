package management

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	coreauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
)

func newQuarantineContext(t *testing.T) (*gin.Context, *httptest.ResponseRecorder) {
	t.Helper()
	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)
	return c, recorder
}

func TestManagementQuarantineRefusedNilAuth(t *testing.T) {
	if managementQuarantineRefused(nil) {
		t.Fatal("nil auth must never be refused; upstream behavior for nil is unchanged")
	}
}

func TestManagementQuarantineRefusedEnabledAuth(t *testing.T) {
	auth := &coreauth.Auth{ID: "enabled.json", Provider: "gemini", Status: coreauth.StatusActive}
	if managementQuarantineRefused(auth) {
		t.Fatal("enabled auth must not be refused")
	}
	if auth.Disabled || auth.Status != coreauth.StatusActive {
		t.Fatal("guard must not mutate enabled auth state")
	}
}

func TestManagementQuarantineRefusedDisabledFlag(t *testing.T) {
	auth := &coreauth.Auth{ID: "disabled-flag.json", Provider: "claude", Disabled: true}
	if !managementQuarantineRefused(auth) {
		t.Fatal("Disabled=true must be refused")
	}
	if auth.Status != "" {
		t.Fatalf("guard must not clear or rewrite Status, got %q", auth.Status)
	}
}

func TestManagementQuarantineRefusedDisabledStatus(t *testing.T) {
	auth := &coreauth.Auth{ID: "disabled-status.json", Provider: "codex", Status: coreauth.StatusDisabled}
	if !managementQuarantineRefused(auth) {
		t.Fatal("Status=StatusDisabled must be refused")
	}
	if auth.Disabled {
		t.Fatal("guard must not clear or rewrite Disabled")
	}
}

func TestManagementQuarantineGuardWritesLocal403(t *testing.T) {
	c, recorder := newQuarantineContext(t)
	auth := &coreauth.Auth{ID: "quarantined.json", Provider: "openai-compatibility", Disabled: true}

	if !managementQuarantineGuard(c, auth) {
		t.Fatal("guard must report refusal for disabled auth")
	}
	if recorder.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusForbidden)
	}
	var payload map[string]any
	if errDecode := json.NewDecoder(recorder.Body).Decode(&payload); errDecode != nil {
		t.Fatalf("decode body: %v", errDecode)
	}
	if payload["error"] != ManagementQuarantineErrorCode {
		t.Fatalf("error code = %v, want %q", payload["error"], ManagementQuarantineErrorCode)
	}
	if msg, _ := payload["message"].(string); !strings.Contains(msg, "disabled") {
		t.Fatalf("message = %q, want mention of disabled credential", msg)
	}
}

func TestManagementQuarantineGuardEnabledAuthPassesThrough(t *testing.T) {
	c, recorder := newQuarantineContext(t)
	auth := &coreauth.Auth{ID: "live.json", Provider: "gemini", Status: coreauth.StatusActive}

	if managementQuarantineGuard(c, auth) {
		t.Fatal("guard must not refuse enabled auth")
	}
	if recorder.Code != http.StatusOK || recorder.Body.Len() != 0 {
		t.Fatalf("guard wrote a response for enabled auth: code=%d body=%q", recorder.Code, recorder.Body.String())
	}
}

// The guard runs before token resolution and upstream dispatch: a disabled
// credential must produce a local 403 with zero upstream requests, while the
// same enabled credential still reaches upstream via the real APICall path.
func TestAPICallDisabledAuthQuarantinedBeforeUpstream(t *testing.T) {
	var upstreamHits int
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstreamHits++
		_, _ = w.Write([]byte("reached upstream"))
	}))
	defer upstream.Close()

	manager := coreauth.NewManager(nil, &coreauth.RoundRobinSelector{}, nil)
	disabledAuth := &coreauth.Auth{
		ID:       "quarantined-credential.json",
		Provider: "devin",
		Disabled: true,
		Attributes: map[string]string{
			"api_key": "quarantine-fake-key",
		},
		Metadata: map[string]any{
			"type":    "devin",
			"api_key": "quarantine-fake-key",
		},
	}
	if _, errRegister := manager.Register(context.Background(), disabledAuth); errRegister != nil {
		t.Fatalf("register disabled auth: %v", errRegister)
	}
	authIndex := disabledAuth.EnsureIndex()

	h := &Handler{authManager: manager}
	router := gin.New()
	router.POST("/", h.APICall)

	body := `{"auth_index":"` + authIndex + `","method":"GET","url":"` + upstream.URL + `/ping","header":{"Authorization":"Bearer $TOKEN$"}}`
	recorder := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(recorder, req)

	if recorder.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want %d; body = %s", recorder.Code, http.StatusForbidden, recorder.Body.String())
	}
	var payload map[string]any
	if errDecode := json.NewDecoder(recorder.Body).Decode(&payload); errDecode != nil {
		t.Fatalf("decode body: %v", errDecode)
	}
	if payload["error"] != ManagementQuarantineErrorCode {
		t.Fatalf("error code = %v, want %q", payload["error"], ManagementQuarantineErrorCode)
	}
	if upstreamHits != 0 {
		t.Fatalf("disabled credential reached upstream %d time(s); guard must run before dispatch", upstreamHits)
	}
}

func TestAPICallEnabledAuthStillReachesUpstream(t *testing.T) {
	var upstreamHits int
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstreamHits++
		if got := r.Header.Get("Authorization"); got != "Bearer quarantine-fake-key" {
			t.Errorf("upstream Authorization = %q, want token substitution", got)
		}
		_, _ = w.Write([]byte("upstream-ok"))
	}))
	defer upstream.Close()

	manager := coreauth.NewManager(nil, &coreauth.RoundRobinSelector{}, nil)
	enabledAuth := &coreauth.Auth{
		ID:       "enabled-credential.json",
		Provider: "devin",
		Status:   coreauth.StatusActive,
		Attributes: map[string]string{
			"api_key": "quarantine-fake-key",
		},
		Metadata: map[string]any{
			"type":    "devin",
			"api_key": "quarantine-fake-key",
		},
	}
	if _, errRegister := manager.Register(context.Background(), enabledAuth); errRegister != nil {
		t.Fatalf("register enabled auth: %v", errRegister)
	}
	authIndex := enabledAuth.EnsureIndex()

	h := &Handler{authManager: manager}
	router := gin.New()
	router.POST("/", h.APICall)

	body := `{"auth_index":"` + authIndex + `","method":"GET","url":"` + upstream.URL + `/ping","header":{"Authorization":"Bearer $TOKEN$"}}`
	recorder := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(recorder, req)

	if upstreamHits == 0 {
		t.Fatal("enabled credential never reached upstream; quarantine must not over-block")
	}
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body = %s", recorder.Code, http.StatusOK, recorder.Body.String())
	}
	var response apiCallResponse
	if errDecode := json.NewDecoder(recorder.Body).Decode(&response); errDecode != nil {
		t.Fatalf("decode response: %v", errDecode)
	}
	if response.Body != "upstream-ok" {
		t.Fatalf("upstream body = %q, want %q", response.Body, "upstream-ok")
	}
}

// VerifyInference (pinned v8.0.49) already refuses disabled credentials before
// any executor work. This asserts that SDK refusal stays in place, so the
// quarantine guard never needs to weaken or duplicate it there.
func TestVerifyInferenceRefusesDisabledCredential(t *testing.T) {
	manager := coreauth.NewManager(nil, &coreauth.RoundRobinSelector{}, nil)
	disabledAuth := &coreauth.Auth{
		ID:       "verify-disabled.json",
		Provider: "devin",
		Disabled: true,
		Attributes: map[string]string{
			"api_key": "quarantine-fake-key",
		},
	}
	if _, errRegister := manager.Register(context.Background(), disabledAuth); errRegister != nil {
		t.Fatalf("register disabled auth: %v", errRegister)
	}

	updated, errVerify := manager.VerifyInference(context.Background(), disabledAuth.ID, "")
	if errVerify == nil {
		t.Fatal("VerifyInference must refuse a disabled credential")
	}
	sdkErr, okErr := errVerify.(*coreauth.Error)
	if !okErr || sdkErr == nil {
		t.Fatalf("error type = %T, want *coreauth.Error", errVerify)
	}
	if sdkErr.Code != "auth_disabled" {
		t.Fatalf("error code = %q, want %q", sdkErr.Code, "auth_disabled")
	}
	if sdkErr.HTTPStatus != http.StatusConflict {
		t.Fatalf("http status = %d, want %d", sdkErr.HTTPStatus, http.StatusConflict)
	}
	if updated == nil || updated.ID != disabledAuth.ID {
		t.Fatalf("updated auth = %+v, want the same credential returned", updated)
	}
}
