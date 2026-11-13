package opencode

import (
	"strings"
	"testing"
)

// TestValidSessionIDMatchesNativeShape pins the native session id shape from
// packages/schema/src/session-id.ts + identifier.ts: "ses_" + descending()
// where descending() is 12 lowercase hex chars (bit-inverted ms-timestamp
// counter) followed by 14 chars of the 62-char alphabet. The known working
// sessions follow it (e.g. ses_e6983cfa5ffejQiSHP0zl9KfzV,
// ses_e69be2426ffemndjU4cCW5nKtB, ses_e7e28fa42ffex6qBXbtGHzwLKe).
func TestValidSessionIDMatchesNativeShape(t *testing.T) {
	valid := []string{
		"ses_e6983cfa5ffejQiSHP0zl9KfzV",
		"ses_e69be2426ffemndjU4cCW5nKtB",
		"ses_e7e28fa42ffex6qBXbtGHzwLKe",
		"ses_e83992e9fffeTSqEe47Tds5oX0",
		"ses_e7e2d3017ffeMNL4rtoVtpHCYC",
		"ses_e809e5282ffe0QZUd5xwf20Pxi",
	}
	for _, id := range valid {
		if !ValidSessionID(id) {
			t.Errorf("ValidSessionID(%q) = false, want native-shape match", id)
		}
	}
	invalid := []string{
		"",
		"   ",
		"abc_e6983cfa5ffejQiSHP0zl9KfzV",
		"ses_short",
		"ses_e6983cfa5ffejQiSHP0zl9KfzVExtra",
		"ses_E6983CFA5FFEJQISHP0ZL9KFZV",
		"header:ses_e6983cfa5ffejQiSHP0zl9KfzV",
		"ctx:v1:abc",
	}
	for _, id := range invalid {
		if ValidSessionID(id) {
			t.Errorf("ValidSessionID(%q) = true, want false (not the native shape)", id)
		}
	}
}

// TestSessionIdentityAppliesNativeBinding pins the pure binding rules: a
// valid session id stands as the session id and becomes its own affinity
// when no affinity is supplied (affinity.ts: a session with no parent/fork
// is its own affinity root); a distinct affinity is preserved; the 64-hex
// affinity variant sets the affinity headers without inventing a session id.
func TestSessionIdentityAppliesNativeBinding(t *testing.T) {
	const realSession = "ses_e6983cfa5ffejQiSHP0zl9KfzV"
	const other = "ses_e69be2426ffemndjU4cCW5nKtB"

	sessionID, affinity := SessionIdentity(realSession, "")
	if sessionID != realSession || affinity != realSession {
		t.Errorf("SessionIdentity(real id) = %q/%q, want accepted with affinity fallback", sessionID, affinity)
	}

	sessionID, affinity = SessionIdentity("", realSession)
	if sessionID != realSession || affinity != realSession {
		t.Errorf("SessionIdentity(affinity only) = %q/%q, want session derived from affinity", sessionID, affinity)
	}

	sessionID, affinity = SessionIdentity(realSession, other)
	if sessionID != realSession || affinity != other {
		t.Errorf("SessionIdentity(distinct affinity) = %q/%q, want both preserved", sessionID, affinity)
	}

	// 64-hex affinity variant: affinity passes, no session id is invented.
	hex64 := "ses_" + strings.Repeat("a", 64)
	sessionID, affinity = SessionIdentity("", hex64)
	if sessionID != "" || affinity != hex64 {
		t.Errorf("SessionIdentity(64-hex affinity) = %q/%q, want empty session id with the affinity preserved", sessionID, affinity)
	}

	// Foreign namespaces are not native identities: values pass through
	// unchanged for the caller; the registry path decides usability.
	sessionID, affinity = SessionIdentity("header:0f4a6f1a", "affinity:xyz")
	if sessionID != "header:0f4a6f1a" || affinity != "affinity:xyz" {
		t.Errorf("SessionIdentity(foreign) = %q/%q, want values passed through untouched", sessionID, affinity)
	}
}

// TestSessionIdentityNoLongerFailsClosed pins the corrected contract: the
// pure resolver never errors; when no caller identity exists, the handler
// resolves identity through the registry instead (sessionForRequest).
func TestSessionIdentityNoLongerFailsClosed(t *testing.T) {
	sessionID, affinity := SessionIdentity("", "")
	if sessionID != "" || affinity != "" {
		t.Errorf("SessionIdentity(empty) = %q/%q, want empty values (registry path handles it)", sessionID, affinity)
	}
}
