package hostbridge

import "net/http"

// The host also rejects redirects: both HTTP layers must refuse them so a
// single caller inference cannot secretly create a second provider dispatch.
func rejectAutomaticRedirect(*http.Request, []*http.Request) error {
	return http.ErrUseLastResponse
}
