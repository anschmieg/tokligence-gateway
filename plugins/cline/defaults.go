package cline

import (
	"fmt"
	"net/url"
	"strings"
)

// Default upstream endpoints, matching the validated gateway adapter.
const (
	DefaultAPIBaseURL    = "https://api.cline.bot"
	DefaultWorkOSBaseURL = "https://api.workos.com"
)

// SecureBaseURL validates a configured upstream base URL. Tokens are sent to
// these endpoints, so anything but HTTPS is rejected up front rather than
// silently downgrading credential transport to plaintext. Loopback hosts are
// the explicit exception for isolated test deployments.
func SecureBaseURL(raw string) (string, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return "", fmt.Errorf("base URL is empty")
	}
	parsed, err := url.Parse(trimmed)
	if err != nil {
		return "", fmt.Errorf("base URL %q is invalid: %w", raw, err)
	}
	host := strings.ToLower(parsed.Hostname())
	isLoopback := host == "localhost" || host == "127.0.0.1" || host == "::1" || strings.HasSuffix(host, ".localhost") || strings.HasSuffix(host, ".local")
	switch strings.ToLower(parsed.Scheme) {
	case "https":
		return strings.TrimRight(trimmed, "/"), nil
	case "http":
		if isLoopback {
			return strings.TrimRight(trimmed, "/"), nil
		}
		return "", fmt.Errorf("base URL %q must use HTTPS (loopback http is allowed for isolated test deployments)", raw)
	default:
		return "", fmt.Errorf("base URL %q must use http or https", raw)
	}
}
