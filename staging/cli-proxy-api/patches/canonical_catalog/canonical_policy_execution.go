package auth

import "github.com/router-for-me/CLIProxyAPI/v8/internal/registry"

func canonicalOneDispatch(meta map[string]any) bool {
	v, _ := meta["gateway.canonical_dispatch"].(bool)
	return v
}
func canonicalAttemptExclusions(meta map[string]any) []string {
	v, _ := meta["gateway.canonical_excluded_auths"].([]string)
	return v
}
func (m *Manager) CanonicalRoutingPolicy() registry.CanonicalRoutingConfig {
	cfg := m.runtimeConfigSnapshot()
	if cfg == nil {
		return registry.CanonicalRoutingConfig{}
	}
	p := cfg.Models.CanonicalRouting
	if p.FreeFallbacks != nil {
		out := map[string][]string{}
		for k, v := range p.FreeFallbacks {
			out[k] = append([]string{}, v...)
		}
		p.FreeFallbacks = out
	}
	return p
}
