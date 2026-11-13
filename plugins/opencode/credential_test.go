package opencode

import (
	"encoding/json"
	"testing"
)

// nativeCredentialFixture is the exact value the native login flow writes
// (opencode.ts credential(): Credential.OAuth.make with server/accountID/
// email/orgID/orgName metadata), as it appears in a seeded auth-dir file.
const nativeCredentialFixture = `{
  "type": "oauth",
  "methodID": "device",
  "access": "access-token-value",
  "refresh": "refresh-token-value",
  "expires": 1762000000000,
  "metadata": {
    "server": "https://opencode.ai/console",
    "accountID": "usr_123",
    "email": "user@example.com",
    "orgID": "org_456",
    "orgName": "Example Org"
  }
}`

// TestParseCredentialAcceptsNativeShape pins the parser to the native
// Credential.OAuth schema (packages/schema/src/credential.ts). The rejected
// candidate required the legacy `type: opencode` shape, which no native
// version writes.
func TestParseCredentialAcceptsNativeShape(t *testing.T) {
	credential, err := ParseCredential([]byte(nativeCredentialFixture))
	if err != nil {
		t.Fatalf("ParseCredential(native fixture) error = %v", err)
	}
	if credential.Type != "oauth" {
		t.Errorf("Type = %q, want oauth", credential.Type)
	}
	if credential.MethodID != "device" {
		t.Errorf("MethodID = %q, want device (native methodID)", credential.MethodID)
	}
	if credential.Access != "access-token-value" || credential.Refresh != "refresh-token-value" {
		t.Errorf("tokens not preserved: %+v", credential)
	}
	if credential.Expiry() != 1762000000000 {
		t.Errorf("Expiry() = %d, want 1762000000000 (native ms epoch)", credential.Expiry())
	}
}

// TestParseCredentialDeclinesForeignShapes pins the fail-closed boundary:
// key-type credentials, the candidate's legacy shape, and API-key-shaped
// payloads are declined so another parser can run. No fallback to API-key,
// anonymous or public access exists.
func TestParseCredentialDeclinesForeignShapes(t *testing.T) {
	cases := map[string]string{
		"empty":            ``,
		"invalid json":     `{`,
		"legacy candidate": `{"type":"opencode","access":"a","refresh":"r","expires":1}`,
		"key type":         `{"type":"key","key":"sk-x"}`,
		"oauth no refresh": `{"type":"oauth","methodID":"device","access":"a","expires":1}`,
		"api-key shape":    `{"apiKey":"sk-x","expiresAt":"2026-01-01T00:00:00Z"}`,
	}
	for name, raw := range cases {
		if _, err := ParseCredential([]byte(raw)); err == nil {
			t.Errorf("ParseCredential(%s) succeeded, want decline", name)
		}
	}
}

// TestCredentialServerNormalization pins the native console-access.ts
// server() normalization: the retired console.opencode.ai host maps
// path-for-path onto the default server.
func TestCredentialServerNormalization(t *testing.T) {
	credential, err := ParseCredential([]byte(nativeCredentialFixture))
	if err != nil {
		t.Fatalf("ParseCredential error = %v", err)
	}
	if got := credential.Server(); got != "https://opencode.ai/console" {
		t.Errorf("Server() = %q, want normalized default", got)
	}
	legacy := `{"type":"oauth","methodID":"device","access":"a","refresh":"r","expires":1,"metadata":{"server":"https://console.opencode.ai"}}`
	parsed, err := ParseCredential([]byte(legacy))
	if err != nil {
		t.Fatalf("ParseCredential(legacy server) error = %v", err)
	}
	if got := parsed.Server(); got != DefaultConsoleServer {
		t.Errorf("Server() = %q, want %q", got, DefaultConsoleServer)
	}
	noMeta := `{"type":"oauth","methodID":"device","access":"a","refresh":"r","expires":1}`
	parsed, err = ParseCredential([]byte(noMeta))
	if err != nil {
		t.Fatalf("ParseCredential(no metadata) error = %v", err)
	}
	if got := parsed.Server(); got != DefaultConsoleServer {
		t.Errorf("Server() = %q, want default when metadata is absent", got)
	}
}

// TestConsoleHeadersMatchesConsoleAccess pins the Console API header set:
// bearer plus x-org-id only when the credential records an organization
// (console-access.ts headers()). Inference must NOT send x-org-id — that is
// the rejected candidate's unsupported org injection.
func TestConsoleHeadersMatchesConsoleAccess(t *testing.T) {
	credential, err := ParseCredential([]byte(nativeCredentialFixture))
	if err != nil {
		t.Fatalf("ParseCredential error = %v", err)
	}
	headers, err := credential.ConsoleHeaders()
	if err != nil {
		t.Fatalf("ConsoleHeaders error = %v", err)
	}
	if headers["authorization"] != "Bearer access-token-value" {
		t.Errorf("authorization = %q, want Bearer access", headers["authorization"])
	}
	if headers["x-org-id"] != "org_456" {
		t.Errorf("x-org-id = %q, want org_456 from metadata", headers["x-org-id"])
	}
	noOrg := `{"type":"oauth","methodID":"device","access":"a","refresh":"r","expires":1}`
	parsed, _ := ParseCredential([]byte(noOrg))
	headers, err = parsed.ConsoleHeaders()
	if err != nil {
		t.Fatalf("ConsoleHeaders(no org) error = %v", err)
	}
	if _, exists := headers["x-org-id"]; exists {
		t.Errorf("x-org-id present without org metadata; native omits the header")
	}
}

// TestExpiryAdmission pins the expiry window used before dispatch: the
// native integration.ts expiring() refreshes when expires <= now + 5min, and
// an unrecorded expiry counts as expired (never dispatched blind).
func TestExpiryAdmission(t *testing.T) {
	now := int64(1761999000000) // 1000s before the fixture expiry
	credential, err := ParseCredential([]byte(nativeCredentialFixture))
	if err != nil {
		t.Fatalf("ParseCredential error = %v", err)
	}
	if credential.ExpiredAt(now) {
		t.Errorf("ExpiredAt(now) = true with 1000s left, want false")
	}
	if !credential.ExpiredAt(credential.Expiry()) {
		t.Errorf("ExpiredAt(expiry) = false, want expired at the instant")
	}
	noExpiry := `{"type":"oauth","methodID":"device","access":"a","refresh":"r"}`
	parsed, _ := ParseCredential([]byte(noExpiry))
	if !parsed.ExpiredAt(now) {
		t.Errorf("ExpiredAt(no expires) = false, want true (never dispatch blind)")
	}
	next := credential.NextRefreshAfter(now, DefaultRefreshBufferMs)
	if next != credential.Expiry()-DefaultRefreshBufferMs {
		t.Errorf("NextRefreshAfter = %d, want expiry minus the native 5min buffer", next)
	}
}

// TestRefreshTokenResponseMatchesNative pins the refresh rotation against
// opencode.ts refresh(): both tokens rotate, expiry is now + expires_in ms,
// a non-null org_id updates metadata.orgID and orgName falls back to the id
// when the org changed (the native flow only keeps orgName on org match).
func TestRefreshTokenResponseMatchesNative(t *testing.T) {
	credential, err := ParseCredential([]byte(nativeCredentialFixture))
	if err != nil {
		t.Fatalf("ParseCredential error = %v", err)
	}
	now := int64(1761900000000)
	body, _ := json.Marshal(map[string]any{
		"access_token":  "new-access",
		"refresh_token": "new-refresh",
		"expires_in":    3600,
		"org_id":        "org_456",
	})
	rotated, err := RefreshTokenResponse(body, credential, now)
	if err != nil {
		t.Fatalf("RefreshTokenResponse error = %v", err)
	}
	if rotated.Access != "new-access" || rotated.Refresh != "new-refresh" {
		t.Errorf("rotated tokens = %+v, want both replaced", rotated)
	}
	if rotated.Expiry() != now+3600*1000 {
		t.Errorf("rotated expiry = %d, want now + 3600s in ms", rotated.Expiry())
	}
	var metadata struct {
		Server  string `json:"server"`
		Email   string `json:"email"`
		OrgID   string `json:"orgID"`
		OrgName string `json:"orgName"`
	}
	if err := json.Unmarshal(rotated.Metadata, &metadata); err != nil {
		t.Fatalf("rotated metadata invalid: %v", err)
	}
	// Same org: native keeps the existing orgName.
	if metadata.OrgID != "org_456" || metadata.OrgName != "Example Org" || metadata.Server != "https://opencode.ai/console" {
		t.Errorf("same-org rotation lost metadata: %+v", metadata)
	}
	// Changed org: native replaces orgName with the id.
	changed, _ := json.Marshal(map[string]any{
		"access_token":  "a2",
		"refresh_token": "r2",
		"expires_in":    60,
		"org_id":        "org_999",
	})
	rotated2, err := RefreshTokenResponse(changed, credential, now)
	if err != nil {
		t.Fatalf("RefreshTokenResponse(changed org) error = %v", err)
	}
	var metadata2 struct {
		OrgID   string `json:"orgID"`
		OrgName string `json:"orgName"`
	}
	_ = json.Unmarshal(rotated2.Metadata, &metadata2)
	if metadata2.OrgID != "org_999" || metadata2.OrgName != "org_999" {
		t.Errorf("changed org: orgID/orgName = %q/%q, want org_999/org_999", metadata2.OrgID, metadata2.OrgName)
	}
}

// TestRefreshTokenResponseDeclinesInvalid pins the fail-closed token
// response validation: missing tokens or expiry never produce a credential.
func TestRefreshTokenResponseDeclinesInvalid(t *testing.T) {
	credential, _ := ParseCredential([]byte(nativeCredentialFixture))
	cases := map[string]string{
		"no access":  `{"refresh_token":"r","expires_in":60}`,
		"no refresh": `{"access_token":"a","expires_in":60}`,
		"no expiry":  `{"access_token":"a","refresh_token":"r"}`,
		"garbage":    `not json`,
	}
	for name, body := range cases {
		if _, err := RefreshTokenResponse([]byte(body), credential, 0); err == nil {
			t.Errorf("RefreshTokenResponse(%s) succeeded, want error", name)
		}
	}
}

// TestSignedOutIsTerminal pins the native SignedOut semantics: 400
// invalid_grant means the session was revoked and only a new device login
// recovers. The plugin must never retry it.
func TestSignedOutIsTerminal(t *testing.T) {
	err := &SignedOutError{Detail: "invalid_grant"}
	if !IsSignedOut(err) {
		t.Errorf("IsSignedOut(SignedOutError) = false, want true")
	}
	if IsSignedOut(nil) {
		t.Errorf("IsSignedOut(nil) = true, want false")
	}
	wrapped := withStatus(401, err)
	if !IsSignedOut(wrapped) {
		t.Errorf("IsSignedOut(wrapped SignedOutError) = false, want true (unwraps)")
	}
	if got := err.Error(); got == "" {
		t.Errorf("SignedOutError message is empty")
	}
}
