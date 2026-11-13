package app

import "testing"

func TestClineSavedNativeCredentialWithGitHubLabel(t *testing.T) {
	a, err := New(Options{Factories: BuiltinFactories()})
	if err != nil {
		t.Fatal(err)
	}
	raw := []byte(`{"type":"freehub","accessToken":"fake-access","refreshToken":"fake-refresh","expiresAt":1700000000,"email":"fixture@github.example","label":"fixture"}`)
	c, ok := a.registry.ParseCredential(raw, "cline-fixture@github.example.json", nil)
	if !ok || c.VendorIDValue() != "cline" {
		t.Fatal("saved Cline credential was not attributed to Cline")
	}
	if c.RefreshTokenValue() != "fake-refresh" || c.ExpiresAt != 1700000000 {
		t.Fatal("attribution changed credential material or expiry")
	}
}
