package cliproxy

import (
	"github.com/router-for-me/CLIProxyAPI/v8/internal/registry"
	coreauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/config"
	"testing"
	"time"
)

func TestRegressionOAuthIsNotBillingEvidence(t *testing.T) {
	cfg := &config.Config{Models: registry.CatalogSources{CanonicalOnly: true}}
	a := &coreauth.Auth{ID: "fixture-subscription", Provider: "codex", Attributes: map[string]string{coreauth.AttributeAuthKind: coreauth.AuthKindOAuth}}
	s := &Service{}
	hasFree := func() bool {
		for _, info := range s.canonicalizeRegisteredModels(cfg, a, []*ModelInfo{{ID: "fixture-model", OwnedBy: "openai"}}) {
			if info.ID == "fixture-model:free" {
				return true
			}
		}
		return false
	}
	if hasFree() {
		t.Fatal("OAuth admitted without verified no-overage allowance")
	}
	cfg.Models.CanonicalRouting.NoChargeAllowances = []registry.NoChargeAllowance{{Provider: "codex", AuthID: a.ID, SourceModels: []string{"fixture-model"}, Basis: "fixture provider no-overage setting verified", VerifiedUntil: time.Now().Add(time.Hour).UTC().Format(time.RFC3339), NoPaidOverage: true}}
	if !hasFree() {
		t.Fatal("verified included allowance not admitted")
	}
	cfg.Models.CanonicalRouting.NoChargeAllowances[0].VerifiedUntil = time.Now().Add(-time.Hour).UTC().Format(time.RFC3339)
	if hasFree() {
		t.Fatal("expired receipt still admits included usage")
	}
}
