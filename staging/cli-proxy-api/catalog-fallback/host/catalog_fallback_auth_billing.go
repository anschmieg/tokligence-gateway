package auth

import (
	"context"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/registry"
	"time"
)

// Classification comes from current selected account/source evidence. Requested
// model spelling and session permission are NEVER billing evidence.
func (m *Manager) CanonicalBillingClass(a *Auth, info *registry.ModelInfo, now time.Time) registry.BillingPolicy {
	if a == nil || info == nil {
		return registry.BillingUnknown
	}
	if info.PluginCostTier == "free" || info.CanonicalCostBasis == "catalog-zero-price" {
		return registry.BillingFree
	}
	cfg := m.runtimeConfigSnapshot()
	if cfg != nil {
		source := info.CanonicalSourceID
		if info.PluginSourceModelID != "" {
			source = info.PluginSourceModelID
		}
		if class := registry.NoChargeAllowanceClass(cfg.Models.CanonicalRouting.NoChargeAllowances, a.Provider, a.ID, source, now); class != registry.BillingUnknown {
			return class
		}
	}
	if info.PluginCostTier == "paid" || info.CanonicalCostBasis == "catalog-metered-price" {
		return registry.BillingPaid
	}
	return registry.BillingUnknown
}
func (m *Manager) CanonicalBillingAvailable(id, route string, now time.Time, policy registry.BillingPolicy) bool {
	a, ok := m.GetByID(id)
	if !ok {
		return false
	}
	info := registry.GetGlobalRegistry().CanonicalRouteInfos(route)[id]
	if info == nil || !policy.Allows(m.CanonicalBillingClass(a, info, now)) {
		return false
	}
	if !registry.GetGlobalRegistry().CanonicalFallbackRegistryAvailable(id, route, now) {
		return false
	}
	for _, key := range []string{route, info.CanonicalSourceID, info.MetadataModelID} {
		if key != "" {
			if blocked, _, _ := isAuthBlockedForModel(a, key, now); blocked {
				return false
			}
		}
	}
	return true
}
func (m *Manager) guardBillingDispatch(ctx context.Context, a *Auth, info *registry.ModelInfo, model string) error {
	policy := registry.DispatchBilling(ctx)
	trace := registry.RoutingTraceFromContext(ctx)
	class := m.CanonicalBillingClass(a, info, time.Now())
	if !policy.Allows(class) {
		return &Error{Code: "billing_policy_refused", Message: "selected route does not satisfy billing policy", HTTPStatus: 403}
	}
	if trace != nil {
		reported := class
		if registry.UncertainFeatureCost(ctx) {
			reported = registry.BillingUnknown
		}
		trace.Select(reported, model, info.OwnedBy)
	}
	return nil
}
