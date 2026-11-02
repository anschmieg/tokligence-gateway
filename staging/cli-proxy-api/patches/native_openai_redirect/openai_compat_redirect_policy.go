package executor

import (
	"context"
	"net/http"
	"strings"
	"time"

	"github.com/router-for-me/CLIProxyAPI/v8/internal/runtime/executor/helps"
	cliproxyauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
)

// Preserve the selected transport/proxy/pool and decorator. Only explicitly
// configured routes refuse automatic HTTP redirects; upstream defaults remain.
func (e *OpenAICompatExecutor) dispatchHTTPClient(ctx context.Context, auth *cliproxyauth.Auth, timeout time.Duration) *http.Client {
	client := helps.NewProxyAwareHTTPClient(ctx, e.cfg, auth, timeout)
	if e.cfg == nil {
		return client
	}
	for _, entry := range e.cfg.OpenAICompatibility {
		if strings.EqualFold(strings.TrimSpace(entry.Name), strings.TrimSpace(e.provider)) {
			if entry.DisableRedirects {
				copy := *client
				copy.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
				return &copy
			}
			break
		}
	}
	return client
}
