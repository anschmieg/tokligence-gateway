package auth

import (
	"github.com/router-for-me/CLIProxyAPI/v8/internal/registry"
	"time"
)

// Re-evaluate current configuration and expiry at actual dispatch. Publication
// alone is insufficient: an allowance can expire/revoke while a plan is queued.
func (m *Manager) CanonicalNoChargeAllowed(a *Auth, info *registry.ModelInfo, now time.Time) bool {
	if a == nil || info == nil || !info.CanonicalFree {
		return false
	}
	if info.PluginCostTier == "free" {
		return true
	} // positive trusted producer receipt, never auth kind
	cfg := m.runtimeConfigSnapshot()
	if cfg == nil {
		return false
	}
	// Native catalog-backed zero pricing is separately proven during publication.
	// Only native compatible registrations have this policy label, not OAuth.
	if info.CanonicalCostBasis == "catalog-zero-price" {
		return true
	}
	source := info.CanonicalSourceID
	if info.PluginSourceModelID != "" {
		source = info.PluginSourceModelID
	}
	return registry.NoChargeAllowanceValid(cfg.Models.CanonicalRouting.NoChargeAllowances, a.Provider, a.ID, source, now)
}
