package pluginhost

import (
	"net/http"
	"strings"
)

// Provider-scoped exception until the mainline plugin SDK exposes redirect
// control. A redirect is another physical request, outside the admitted budget.
// Clone the client value: never mutate shared policy or alter other providers.
func providerDispatchClient(client *http.Client, provider string) *http.Client {
	switch strings.ToLower(strings.TrimSpace(provider)) {
	case "opencode", "cline", "freehub", "free-model-hub":
		copy := *client
		copy.CheckRedirect = func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		}
		return &copy
	default:
		return client
	}
}
