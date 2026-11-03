package app

import (
	"free-model-hub/cpasdk/pluginapi"
	"sync"
)

type canonicalCostReceipt struct {
	vendor string
	models map[string]string
}
type canonicalCostLedger struct {
	mu    sync.RWMutex
	auths map[string]canonicalCostReceipt
}

// Set is called by model.for_auth before publishing. A failed or empty refresh
// revokes that credential's grants. Another organization's catalog cannot grant
// or withdraw cost eligibility for this credential.
func (l *canonicalCostLedger) Set(auth, vendor string, models []pluginapi.ModelInfo) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.auths == nil {
		l.auths = map[string]canonicalCostReceipt{}
	}
	if auth == "" {
		return
	}
	if vendor == "" || len(models) == 0 {
		delete(l.auths, auth)
		return
	}
	receipt := canonicalCostReceipt{vendor: vendor, models: map[string]string{}}
	for _, m := range models {
		source := m.SourceModelID
		if source == "" {
			source = m.ID
		}
		receipt.models[source] = m.CostTier
	}
	l.auths[auth] = receipt
}
func (l *canonicalCostLedger) Admitted(auth, vendor, source, tier string, free bool) bool {
	if auth == "" || source == "" {
		return false
	}
	l.mu.RLock()
	defer l.mu.RUnlock()
	receipt, ok := l.auths[auth]
	if !ok || receipt.vendor != vendor {
		return false
	}
	cost, known := receipt.models[source]
	return known && cost == tier && (!free || tier == "free" || tier == "included")
}
