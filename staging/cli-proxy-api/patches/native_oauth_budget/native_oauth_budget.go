package helps

import (
	coreauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
	"net/http"
	"strings"
)

// Scoped to native OAuth providers admitted under our no-hidden-dispatch policy.
// Keep their transport/TLS behavior and all other providers' clients unchanged.
func NativeOAuthBudgetClient(client *http.Client, auth *coreauth.Auth) *http.Client {
	if client == nil || auth == nil {
		return client
	}
	switch strings.ToLower(strings.TrimSpace(auth.Provider)) {
	case "antigravity", "codex":
		clone := *client
		clone.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
		return &clone
	default:
		return client
	}
}
