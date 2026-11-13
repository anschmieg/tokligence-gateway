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
		return "", fmt.Errorf("base URL is invalid")
	}
	host := strings.ToLower(parsed.Hostname())
	isLoopback := host == "localhost" || host == "127.0.0.1" || host == "::1"
	if host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return "", fmt.Errorf("base URL must have a host and no credentials, query or fragment")
	}
	switch strings.ToLower(parsed.Scheme) {
	case "https":
		return strings.TrimRight(trimmed, "/"), nil
	case "http":
		if isLoopback {
			return strings.TrimRight(trimmed, "/"), nil
		}
		return "", fmt.Errorf("base URL must use HTTPS (literal loopback or localhost HTTP is allowed for isolated tests)")
	default:
		return "", fmt.Errorf("base URL must use http or https")
	}
}
