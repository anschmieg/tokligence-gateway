package app

// vendor_admission.go is a tokligence staging addition for the adopted
// free-model-hub build (source pin: Yousha-dev/free-model-hub
// 4d025efe8046af70327d80f75c5bd5ac6b4505af).
//
// It applies the deployment's vendor admission policy after every full config
// application (plugin.register and plugin.reconfigure both funnel through
// ApplyConfig). Upstream behavior with no keys set is untouched.
//
// Keyless auto-provisioning, model listing, credential claiming and the
// console vendor list all read the registry, so a parked vendor is fully
// inert at boot while its code remains compiled and admit-able later.

import (
	"free-model-hub/internal/logger"
	"free-model-hub/internal/vendors/openaicompat"
)

// applyVendorAdmission enforces allowed_vendors / blocked_vendors.
//
// Called inline during ApplyConfig (inside the host's lifecycle RPC). It
// performs only local registry bookkeeping — no host callbacks, no upstream
// calls — so the synchronous registration path cannot block or deadlock.
func (a *App) applyVendorAdmission(cfg pluginConfig) {
	for _, id := range appendIDs(cfg.AllowedVendors, cfg.BlockedVendors) {
		if !a.registry.Known(id) {
			logger.Info("vendor admission: unknown id %q does not exist in this build (ignoring, keeping config as written)", id)
		}
	}
	a.registry.ApplyAdmission(cfg.AllowedVendors, cfg.BlockedVendors)
	logger.Info("vendor admission applied: allowed=%v blocked=%v parked=%v",
		cfg.AllowedVendors, cfg.BlockedVendors, a.registry.ParkedIDs())
}

func appendIDs(first, second []string) []string {
	out := append([]string(nil), first...)
	out = append(out, second...)
	return out
}

// freeHubVendorIDs documents the vendor IDs this build can admit, for
// operators writing an explicit small allowlist. Login providers and the two
// OpenCode lanes exist as compiled upstream code and stay parked until listed.
func freeHubVendorIDs() []string {
	ids := make([]string, 0, len(openaicompat.Providers)+11)
	for _, provider := range openaicompat.Providers {
		ids = append(ids, provider.ID)
	}
	return append(ids, "opencodezen", "opencodego", "autoclaw", "cline", "codearts",
		"minimaxcode", "qoder", "raccoon", "trae", "workbuddy", "zcode")
}
