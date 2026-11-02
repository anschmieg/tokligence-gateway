package core

import "strings"

// A leading provider marker is stronger evidence than a vendor word inside
// an account label or email. Keep the legacy embedded-marker fallback only
// when no registered provider has an explicit leading marker.
func fileNameHasVendorPrefix(base, vendor string) bool {
	if base == vendor {
		return true
	}
	for _, separator := range []string{"-", "_", "."} {
		if strings.HasPrefix(base, vendor+separator) {
			return true
		}
	}
	return false
}
