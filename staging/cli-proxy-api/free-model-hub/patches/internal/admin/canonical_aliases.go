package admin

// Reviewed identities only. Unknown variants and virtual routers are not folded.
// An operator's per-vendor alias takes precedence. Qualified IDs stay published.
var canonicalAliases = map[string]map[string]string{
	"kilo": {"kilo/nvidia/nemotron-3.5-lightning:free": "nemotron-3.5-lightning"},
}

func canonicalAlias(vendor, model string) string { return canonicalAliases[vendor][model] }

// Canonical defaults never assume an unavailable catalog contains the source.
func (c *Catalog) canonicalSourceRegisteredLocked(vendor, model string) bool {
	for _, info := range c.cached[vendor].models {
		if info.ID == model {
			return true
		}
	}
	return false
}
