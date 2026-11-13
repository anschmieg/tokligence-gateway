package opencodezen

import (
	"encoding/json"
	"strings"
	"testing"
)

// Tests only the custom foreign-ownership guard; upstream suites stay untouched.

func foreignGuardMap(t *testing.T, raw string) map[string]any {
	t.Helper()
	var payload map[string]any
	if err := json.Unmarshal([]byte(raw), &payload); err != nil {
		t.Fatalf("fixture JSON: %v", err)
	}
	return payload
}

func TestIsForeignCredentialJSONRejectsNativeOpenCodeAccount(t *testing.T) {
	native := foreignGuardMap(t, `{"type":"opencode","storage_version":1,"credential":{"type":"oauth","methodID":"device","access":"a","refresh":"r"}}`)
	if !IsForeignCredentialJSON(native) {
		t.Fatal("native tokligence-opencode account file must be marked foreign")
	}
}

func TestIsForeignCredentialJSONRejectsBuiltinEnvelopeWithoutTypeField(t *testing.T) {
	native := foreignGuardMap(t, `{"storage_version":2,"credential":{"type":"key","key":"k"}}`)
	if !IsForeignCredentialJSON(native) {
		t.Fatal("foreign storage_version envelope must be marked foreign even without type")
	}
}

func TestIsForeignCredentialJSONKeepsHubOwnCredentials(t *testing.T) {
	hubKeyless := foreignGuardMap(t, string(AnonymousCredentialJSON("freehub")))
	if IsForeignCredentialJSON(hubKeyless) {
		t.Fatal("this plugin's own anonymous credential must never be marked foreign")
	}
	hubKeyed := foreignGuardMap(t, `{"type":"freehub","vendor":"opencodezen","api_key":"sk-zen","label":"mine"}`)
	if IsForeignCredentialJSON(hubKeyed) {
		t.Fatal("this plugin's own keyed credential must never be marked foreign")
	}
	hubAliased := foreignGuardMap(t, `{"type":"FREEHUB","vendor":"opencodezen","zen_key":"z"}`)
	if IsForeignCredentialJSON(hubAliased) {
		t.Fatal("type comparison must be case-insensitive")
	}
}

func TestLooksLikeCredentialNeverClaimsForeignFileNameConventions(t *testing.T) {
	// Native OpenCode account filenames: banning them here is the point of
	// removing the bare "opencode" segment from the convention list.
	foreignNames := []string{
		"opencode.json",
		"opencode-login-odl_smoke.json",
		"tokligence-opencode.json",
		"my-opencode.json",
	}
	for _, name := range foreignNames {
		empty := foreignGuardMap(t, `{}`)
		if LooksLikeCredential(empty, name, "") {
			t.Fatalf("filename %q must no longer be claimed", name)
		}
		nativeBody := foreignGuardMap(t, `{"type":"opencode","storage_version":1,"credential":{}}`)
		if LooksLikeCredential(nativeBody, name, "opencode") {
			t.Fatalf("native-shaped file %q must be refused even with provider hint", name)
		}
	}
}

func TestLooksLikeCredentialStillClaimsHubOwnedNames(t *testing.T) {
	hub := foreignGuardMap(t, string(AnonymousCredentialJSON("freehub")))
	for _, name := range []string{"opencodezen-free.json", "opencodezen-abc123.json", "zen-manual.json"} {
		if !LooksLikeCredential(hub, name, "") {
			t.Fatalf("hub-owned file %q must still be claimed by this vendor", name)
		}
	}
	// Zen-exclusive field evidence still claims keys without a recognized name.
	if !LooksLikeCredential(foreignGuardMap(t, `{"zen_key":"zk"}`), "anything.json", "") {
		t.Fatal("zen_key evidence must still claim a credential")
	}
}

func TestForeignGuardNormalizeMarker(t *testing.T) {
	if !strings.EqualFold(normalizeMarker("OpenCode"), "opencode") {
		t.Fatal("marker normalization should fold case")
	}
}
