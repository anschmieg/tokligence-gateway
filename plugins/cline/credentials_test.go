package cline

import (
	"encoding/json"
	"testing"
	"time"
)

func TestParseStorageAcceptsValidCredential(t *testing.T) {
	raw := []byte(`{"accessToken":"at","refreshToken":"rt","expiresAt":"2030-11-01T12:00:00Z"}`)
	storage, err := ParseStorage(raw)
	if err != nil {
		t.Fatalf("ParseStorage: %v", err)
	}
	if storage.AccessToken != "at" || storage.RefreshToken != "rt" {
		t.Fatalf("unexpected tokens: %+v", storage)
	}
}

func TestParseStorageRejectsInvalid(t *testing.T) {
	cases := map[string]string{
		"empty":      ``,
		"missing":    `{"accessToken":"","refreshToken":"rt","expiresAt":"2030-11-01T12:00:00Z"}`,
		"no refresh": `{"accessToken":"at","refreshToken":"","expiresAt":"2030-11-01T12:00:00Z"}`,
		"bad expiry": `{"accessToken":"at","refreshToken":"rt","expiresAt":"tomorrow"}`,
		"no expiry":  `{"accessToken":"at","refreshToken":"rt"}`,
		"not json":   `{{`,
	}
	for name, raw := range cases {
		if _, err := ParseStorage([]byte(raw)); err == nil {
			t.Errorf("%s: expected error", name)
		}
	}
}

func TestParseExpiryNormalizesToUTC(t *testing.T) {
	parsed, err := ParseExpiry("2030-11-01T12:00:00.500Z")
	if err != nil {
		t.Fatalf("ParseExpiry: %v", err)
	}
	if got := parsed.Format(time.RFC3339); got != "2030-11-01T12:00:00Z" {
		t.Fatalf("unexpected parsed value: %s", got)
	}
}

func TestTokenResponseRotationKeepsFallbackRefresh(t *testing.T) {
	// Cline refresh can return only a new access token; the previous refresh
	// token must be retained, matching the gateway adapter behavior.
	body := []byte(`{"success":true,"data":{"accessToken":"at2","expiresAt":"2030-11-01T13:00:00Z"}}`)
	storage, err := ParseTokenResponse(body, "rt-old")
	if err != nil {
		t.Fatalf("ParseTokenResponse: %v", err)
	}
	if storage.AccessToken != "at2" || storage.RefreshToken != "rt-old" {
		t.Fatalf("unexpected storage: %+v", storage)
	}
}

func TestTokenResponseRotationUsesRotatedRefresh(t *testing.T) {
	body := []byte(`{"success":true,"data":{"accessToken":"at2","refreshToken":"rt-new","expiresAt":"2030-11-01T13:00:00Z"}}`)
	storage, err := ParseTokenResponse(body, "rt-old")
	if err != nil {
		t.Fatalf("ParseTokenResponse: %v", err)
	}
	if storage.RefreshToken != "rt-new" {
		t.Fatalf("expected rotated refresh token, got %+v", storage)
	}
}

func TestTokenResponseRejectsFailure(t *testing.T) {
	cases := [][]byte{
		[]byte(`{"success":false}`),
		[]byte(`{"success":true,"data":{"accessToken":"","refreshToken":"rt","expiresAt":"2030-11-01T13:00:00Z"}}`),
		[]byte(`{"success":true,"data":{"accessToken":"at","expiresAt":"nonsense"}}`),
		[]byte(`not json`),
	}
	for _, body := range cases {
		if _, err := ParseTokenResponse(body, "rt"); err == nil {
			t.Errorf("expected error for %s", body)
		}
	}
}

func TestNextRefreshAfterSchedulesBeforeExpiry(t *testing.T) {
	expiry := time.Now().UTC().Add(2 * time.Hour).Format(time.RFC3339)
	storage := Storage{AccessToken: "at", RefreshToken: "rt", ExpiresAt: expiry}
	next := storage.NextRefreshAfter(DefaultRefreshBuffer)
	expected := time.Now().UTC().Add(2*time.Hour - DefaultRefreshBuffer)
	delta := next.Sub(expected)
	if delta < -time.Minute || delta > time.Minute {
		t.Fatalf("next refresh %v differs from expected %v", next, expected)
	}
}

func TestNextRefreshAfterExpiredCredentialRefreshesNow(t *testing.T) {
	expiry := time.Now().UTC().Add(-time.Hour).Format(time.RFC3339)
	storage := Storage{AccessToken: "at", RefreshToken: "rt", ExpiresAt: expiry}
	next := storage.NextRefreshAfter(DefaultRefreshBuffer)
	if next.After(time.Now().UTC().Add(time.Minute)) {
		t.Fatalf("expired credential should refresh immediately, got %v", next)
	}
}

func TestStorageRoundTrip(t *testing.T) {
	storage := Storage{AccessToken: "at", RefreshToken: "rt", ExpiresAt: "2030-11-01T12:00:00Z"}
	raw, err := json.Marshal(storage)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	parsed, err := ParseStorage(raw)
	if err != nil {
		t.Fatalf("round trip: %v", err)
	}
	if parsed != storage {
		t.Fatalf("round trip mismatch: %+v", parsed)
	}
}
