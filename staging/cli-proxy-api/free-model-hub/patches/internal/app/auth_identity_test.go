package app

import (
	"free-model-hub/internal/core"
	"testing"
)

func TestFreeHubNativeCredentialFileIdentity(t *testing.T) {
	vendor := &smsLoginStubVendor{writeStubVendor: &writeStubVendor{}}
	credential := &core.Credential{UID: "fixture", Token: "fake"}
	for _, name := range []string{"kilo-free.json", "nested/account.json"} {
		auth, err := buildAuthDataFor(vendor, credential, name, []byte(`{"uid":"fixture"}`))
		if err != nil {
			t.Fatal(err)
		}
		if auth.ID != name || auth.FileName != name {
			t.Fatal("native filename identity changed")
		}
	}
}
