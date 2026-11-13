package registry

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestDraftRegistryExpiryReadDoesNotClearQuotaOrQuarantine(t *testing.T) {
	r := GetGlobalRegistry()
	id := "draft-expiry"
	selector := "draft-expiry:free"
	r.RegisterClient(id, "fixture", []*ModelInfo{{ID: selector, CanonicalID: "draft-expiry", CanonicalPolicy: "free", CanonicalFree: true}})
	t.Cleanup(func() { r.UnregisterClient(id) })
	old := time.Now().Add(-2 * modelQuotaExceededWindow)
	r.mutex.Lock()
	r.models[selector].QuotaExceededClients[id] = &old
	r.models[selector].SuspendedClients[id] = "quota"
	r.mutex.Unlock()
	if !r.CanonicalFallbackRegistryAvailable(id, selector, time.Now()) {
		t.Fatal("expired short registry quota still blocks fallback")
	}
	if !r.IsModelQuotaExceededForClient(id, selector) {
		t.Fatal("eligibility read cleared state")
	}
	r.mutex.Lock()
	r.models[selector].SuspendedClients[id] = "quarantine"
	r.mutex.Unlock()
	if r.CanonicalFallbackRegistryAvailable(id, selector, time.Now()) {
		t.Fatal("persistent quarantine bypassed")
	}
}
func TestDraftEvidenceFetchDoesNotFollowUnapprovedSources(t *testing.T) {
	for _, source := range []string{"http://models.dev/catalog.json", "https://example.org/catalog.json", "https://models.dev/catalog.json?key=fixture", "https://models.dev:443/catalog.json"} {
		if ValidateFallbackEvidenceSource(source) == nil {
			t.Fatal(source)
		}
	}
	file := filepath.Join(t.TempDir(), "catalog.json")
	if err := os.WriteFile(file, []byte(`{"models":{"lab/model":{}},"providers":{}}`), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := readFallbackEvidence(context.Background(), file); err == nil {
		t.Fatal("unstamped local cache can be rejuvenated")
	}
}
