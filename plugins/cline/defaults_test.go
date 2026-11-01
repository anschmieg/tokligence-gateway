package cline

import (
	"strings"
	"testing"
)

func TestSecureBaseURLAcceptsHTTPS(t *testing.T) {
	for _, raw := range []string{"https://api.cline.bot", "https://api.cline.bot/", "  https://api.workos.com  "} {
		validated, err := SecureBaseURL(raw)
		if err != nil {
			t.Fatalf("SecureBaseURL(%q): %v", raw, err)
		}
		if !strings.HasPrefix(validated, "https://") {
			t.Fatalf("validated = %q", validated)
		}
	}
}

func TestSecureBaseURLAllowsLoopbackHTTP(t *testing.T) {
	for _, raw := range []string{
		"http://127.0.0.1:8080",
		"http://localhost:3000",
		"http://[::1]:9000",
	} {
		if _, err := SecureBaseURL(raw); err != nil {
			t.Errorf("SecureBaseURL(%q) must accept loopback: %v", raw, err)
		}
	}
}

func TestSecureBaseURLRejectsPlaintextRemote(t *testing.T) {
	for _, raw := range []string{
		"http://api.cline.bot",
		"http://staging.local",
		"http://staging.localhost",
		"https://user:SECRET@api.cline.bot",
		"https://api.cline.bot?token=SECRET",
		"https:///missing-host",
		"http://10.0.0.5:8080",
		"ftp://api.cline.bot",
		"file:///etc/passwd",
		"",
	} {
		if _, err := SecureBaseURL(raw); err == nil {
			t.Errorf("SecureBaseURL(%q) must be rejected", raw)
		}
	}
}
