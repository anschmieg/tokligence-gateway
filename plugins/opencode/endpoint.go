package opencode

import (
	"fmt"
	"net"
	"net/url"
	"strings"
)

// This is a transport boundary, not discovery: accept HTTPS and literal
// loopback HTTP fixtures only. Never carry credentials in a URL or query.
func secureEndpoint(raw string) (*url.URL, error) {
	u, err := url.Parse(raw)
	if err != nil || u == nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || u.Opaque != "" {
		return nil, fmt.Errorf("opencode endpoint must be an absolute HTTPS URL without userinfo/query/fragment")
	}
	if u.Scheme != "https" {
		ip := net.ParseIP(u.Hostname())
		if u.Scheme != "http" || ip == nil || !ip.IsLoopback() {
			return nil, fmt.Errorf("opencode endpoint requires HTTPS (literal loopback HTTP fixtures excepted)")
		}
	}
	// Escaped paths and dot segments do not belong to the configured service
	// root. Reject rather than normalize before sending a bearer credential.
	if strings.Contains(u.EscapedPath(), "%") || strings.Contains(u.Path, "\\") {
		return nil, fmt.Errorf("opencode endpoint contains an ambiguous path")
	}
	for _, part := range strings.Split(u.Path, "/") {
		if part == "." || part == ".." {
			return nil, fmt.Errorf("opencode endpoint contains a dot segment")
		}
	}
	return u, nil
}

// Only the native config discovery endpoint is supported, not arbitrary
// same-origin management actions. Redirect policy remains the host's job.
func validateConsoleConfigURL(server, target string) error {
	base, err := secureEndpoint(server)
	if err != nil {
		return err
	}
	u, err := secureEndpoint(target)
	if err != nil {
		return err
	}
	if !strings.EqualFold(base.Host, u.Host) || base.Scheme != u.Scheme ||
		u.Path != strings.TrimRight(base.Path, "/")+"/api/v2/config" {
		return fmt.Errorf("opencode passthrough supports only the configured Console config endpoint")
	}
	return nil
}
