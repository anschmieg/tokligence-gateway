package opencode

import (
	"strings"
	"testing"
)

// TestValidSessionIDMatchesNativeShape pins the native session id shape from
// packages/schema/src/session-id.ts + identifier.ts: "ses_" + descending()
// where descending() is 6 lowercase hex chars (bit-inverted ms-timestamp
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

// TestSessionIdentityAcceptsOnlyCallerSuppliedNativeIDs pins the central
// correction to the rejected candidate: the plugin NEVER mints a session id.
// It accepts only a caller-supplied native-shaped identity; everything else
// fails with the exact gap.
func TestSessionIdentityAcceptsOnlyCallerSuppliedNativeIDs(t *testing.T) {
	const realSession = "ses_e6983cfa5ffejQiSHP0zl9KfzV"

	sessionID, affinity, err := SessionIdentity("conv-1", realSession, "")
	if err != nil || sessionID != realSession || affinity != realSession {
		t.Errorf("SessionIdentity(real id) = %q/%q %v, want accepted with affinity fallback", sessionID, affinity, err)
	}

	sessionID, affinity, err = SessionIdentity("conv-1", "", realSession)
	if err != nil || sessionID != realSession || affinity != realSession {
		t.Errorf("SessionIdentity(affinity only) = %q/%q %v, want session derived from affinity", sessionID, affinity, err)
	}

	// Distinct affinity: the native set sends both; affinity wins for the
	// affinity headers, session id for x-opencode-session-id.
	sessionID, affinity, err = SessionIdentity("conv-1", realSession, "ses_e69be2426ffemndjU4cCW5nKtB")
	if err != nil || sessionID != realSession || affinity != "ses_e69be2426ffemndjU4cCW5nKtB" {
		t.Errorf("SessionIdentity(distinct affinity) = %q/%q %v, want both preserved", sessionID, affinity, err)
	}
}

// TestSessionIdentityNamesTheExactGap pins the failure mode: when no identity
// names a created OpenCode session, dispatch fails with a precise error that
// (a) names the requirement, (b) names the framework gap (Session.create
// needs the native runtime's project resolver / event bus / session store,
// not hostable in a dynamic plugin), and (c) never fabricates an id.
func TestSessionIdentityNamesTheExactGap(t *testing.T) {
	for _, tc := range []struct {
		name, sessionID, affinity string
	}{
		{"no identity", "", ""},
		{"foreign namespace", "ctx:v1:abcdef", ""},
		{"host canonical form", "0f4a6f1a-2b3c-4d5e-8f9a-1a2b3c4d5e6f", ""},
		{"wrong shape", "not-a-session", ""},
		{"affinity wrong shape", "", "affinity:xyz"},
	} {
		_, _, err := SessionIdentity("conv-1", tc.sessionID, tc.affinity)
		if err == nil {
			t.Errorf("SessionIdentity(%s) succeeded, want the precise gap error", tc.name)
			continue
		}
		sessionErr, ok := err.(*SessionIdentityError)
		if !ok {
			t.Errorf("SessionIdentity(%s) error type = %T, want *SessionIdentityError", tc.name, err)
			continue
		}
		message := sessionErr.Error()
		if !strings.Contains(message, "Session.create") {
			t.Errorf("%s: gap error does not name the native session creation requirement: %q", tc.name, message)
		}
		if !strings.Contains(message, "does not mint") {
			t.Errorf("%s: gap error does not state the no-minting rule: %q", tc.name, message)
		}
		if !strings.Contains(message, "cannot host") {
			t.Errorf("%s: gap error does not name the framework limitation: %q", tc.name, message)
		}
		if sessionErr.ConversationID != "conv-1" {
			t.Errorf("%s: conversation id = %q, want conv-1 for diagnostics", tc.name, sessionErr.ConversationID)
		}
	}
}

// TestSessionIdentityRejectsForeignHeaderNamespace pins that the host's own
// canonical/derived identities (which carry host namespaces like "header:",
// "affinity:", "derived:", "ctx:v1:") are never forwarded upstream as if
// they were native OpenCode sessions. Only the exact native shape passes.
func TestSessionIdentityRejectsForeignHeaderNamespace(t *testing.T) {
	for _, value := range []string{
		"header:0f4a6f1a-2b3c-4d5e-8f9a-1a2b3c4d5e6f",
		"affinity:xyz",
		"derived:ctx:v1:whatever",
		"execution:abc123",
	} {
		if _, _, err := SessionIdentity("conv-1", value, ""); err == nil {
			t.Errorf("SessionIdentity(%q) succeeded, want rejection of foreign namespace", value)
		}
	}
}
