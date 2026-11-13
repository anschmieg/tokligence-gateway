package app

// Tests only the custom admission decision glue in package app; the registry
// mechanics are covered by internal/core's registry_admission_test.go.

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestAppendIDsCombinesBothLists(t *testing.T) {
	got := appendIDs([]string{"a", "b"}, []string{"c"})
	if strings.Join(got, ",") != "a,b,c" {
		t.Fatalf("appendIDs = %v", got)
	}
}

func TestFreeHubVendorIDsIncludeOpenCodeLanesAndAPIKeyProviders(t *testing.T) {
	ids := freeHubVendorIDs()
	joined := map[string]bool{}
	for _, id := range ids {
		joined[id] = true
	}
	for _, want := range []string{"kilo", "openrouter", "github", "opencodezen", "opencodego", "cline"} {
		if !joined[want] {
			t.Fatalf("freeHubVendorIDs missing %q in %v", want, ids)
		}
	}
}

func TestFreeHubDoesNotClaimForeignNativeCredentials(t *testing.T) {
	a, err := New(Options{})
	if err != nil {
		t.Fatal(err)
	}
	if err = a.registry.Register(&writeStubVendor{}); err != nil {
		t.Fatal(err)
	}
	for _, provider := range []string{"opencode", "codex", "antigravity"} {
		payload, _ := json.Marshal(map[string]any{"Provider": provider, "FileName": "zcode-account.json", "RawJSON": []byte(`{"type":"` + provider + `","access_token":"fake-only"}`)})
		raw, err := a.handleAuthParse(payload)
		if err != nil {
			t.Fatal("foreign credential reached greedy parser:", err)
		}
		var response struct{ Result struct{ Handled bool } }
		if err = json.Unmarshal(raw, &response); err != nil {
			t.Fatal(err)
		}
		if response.Result.Handled {
			t.Fatal("foreign credential claimed")
		}
	}
}
