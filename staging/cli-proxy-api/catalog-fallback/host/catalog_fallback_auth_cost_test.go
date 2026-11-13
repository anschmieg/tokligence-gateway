package auth

import (
	"context"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/registry"
	ex "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/executor"
	"testing"
	"time"
)

func TestRegressionAllowanceExpiryAndRevocationFencePhysicalDispatch(t *testing.T) {
	selector := "receipt-fixture:free"
	e := &openAICompatPoolExecutor{id: openAICompatPoolProviderKey}
	m := newOpenAICompatPoolTestManager(t, selector, nil, e)
	a := m.List()[0]
	info := &registry.ModelInfo{ID: selector, CanonicalID: "receipt-fixture", CanonicalPolicy: "free", CanonicalFree: true, CanonicalSourceID: "fixture-source", PluginCostTier: "included"}
	registry.GetGlobalRegistry().RegisterClient(a.ID, a.Provider, []*registry.ModelInfo{info})
	cfg := *m.runtimeConfigSnapshot()
	cfg.Models.CanonicalRouting.NoChargeAllowances = []registry.NoChargeAllowance{{Provider: a.Provider, AuthID: a.ID, SourceModels: []string{"fixture-source"}, Basis: "fixture endpoint no-overage verified", VerifiedUntil: time.Now().Add(time.Hour).UTC().Format(time.RFC3339), NoPaidOverage: true}}
	m.SetConfig(&cfg)
	if !m.CanonicalNoChargeAllowed(a, info, time.Now()) {
		t.Fatal("valid subscription allowance refused")
	}
	for _, mode := range []string{"revoked", "expired"} {
		opts := reviewPermit(a.ID, selector) // capture while registry still declares included
		changed := cfg
		if mode == "revoked" {
			changed.Models.CanonicalRouting.NoChargeAllowances = nil
		} else {
			changed.Models.CanonicalRouting.NoChargeAllowances = append([]registry.NoChargeAllowance(nil), cfg.Models.CanonicalRouting.NoChargeAllowances...)
			changed.Models.CanonicalRouting.NoChargeAllowances[0].VerifiedUntil = time.Now().Add(-time.Hour).UTC().Format(time.RFC3339)
		}
		m.SetConfig(&changed)
		_, err := m.executeCanonicalGuarded(context.Background(), e, a, ex.Request{Model: "fixture-source", Payload: []byte(`{}`)}, opts)
		if err == nil || len(e.ExecuteModels()) != 0 {
			t.Fatal(mode, err, e.ExecuteModels())
		}
		m.SetConfig(&cfg)
	}
	wrong := *a
	wrong.ID = "other-account"
	if m.CanonicalNoChargeAllowed(&wrong, info, time.Now()) {
		t.Fatal("receipt transferred to another account")
	}
}
