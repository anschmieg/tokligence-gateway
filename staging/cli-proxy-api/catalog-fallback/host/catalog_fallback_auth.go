package auth

import (
	"github.com/router-for-me/CLIProxyAPI/v8/internal/registry"
	"time"
)

func (m *Manager) CanonicalFallbackAvailable(id, route string, now time.Time) bool {
	a, ok := m.GetByID(id)
	if !ok {
		return false
	}
	info := registry.GetGlobalRegistry().CanonicalRouteInfos(route)[id]
	if info == nil || !m.CanonicalNoChargeAllowed(a, info, now) {
		return false
	}
	if !registry.GetGlobalRegistry().CanonicalFallbackRegistryAvailable(id, route, now) {
		return false
	}
	for _, key := range []string{route, info.CanonicalSourceID, info.MetadataModelID} {
		if key == "" {
			continue
		}
		if blocked, _, _ := isAuthBlockedForModel(a, key, now); blocked {
			return false
		}
	}
	return true
}

func (m *Manager) CanonicalPriority(id string) int {
	a, ok := m.GetByID(id)
	if !ok {
		return 0
	}
	return authPriority(a)
}
