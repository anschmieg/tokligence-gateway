package cliproxy

import (
	"github.com/router-for-me/CLIProxyAPI/v8/internal/registry"
	coreauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/config"
	"time"
)

func canonicalAccountNoCharge(cfg *config.Config, a *coreauth.Auth, source string) bool {
	return cfg != nil && a != nil && registry.NoChargeAllowanceValid(cfg.Models.CanonicalRouting.NoChargeAllowances, a.Provider, a.ID, source, time.Now())
}
