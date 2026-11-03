package registry

import (
	"sort"
	"sync/atomic"
)

var canonicalDiscoveryOnly atomic.Bool

func setCanonicalDiscoveryOnly(on bool) {
	canonicalDiscoveryOnly.Store(on)
	r := GetGlobalRegistry()
	r.mutex.Lock()
	defer r.mutex.Unlock()
	r.invalidateAvailableModelsCacheLocked()
}

// canonicalInfoLocked intersects every credential, including different vendors
// hosted by the same plugin. Canonical entries exclude hidden paid/raw collisions.
func (r *ModelRegistry) canonicalInfoLocked(id string, reg *ModelRegistration, provider string) *ModelInfo {
	if reg == nil {
		return nil
	}
	infos := map[string]*ModelInfo{}
	visible := false
	canonicalized := false
	for client, byID := range r.clientModelInfos {
		if provider != "" && r.clientProviders[client] != provider {
			continue
		}
		if info := byID[id]; info != nil {
			infos[client] = info
			if info.CanonicalID != "" {
				canonicalized = true
			}
			if canonicalRouteEntry(info) {
				visible = true
			}
		}
	}
	if !canonicalized {
		if provider != "" {
			if info := reg.InfoByProvider[provider]; info != nil {
				return cloneModelInfo(info)
			}
		}
		return commonModelInfo(reg)
	}
	if len(infos) == 0 {
		return commonModelInfo(reg)
	}
	synthetic := &ModelRegistration{Info: reg.Info, InfoByProvider: map[string]*ModelInfo{}, Providers: map[string]int{}}
	for client, info := range infos {
		if info.CanonicalID == "" {
			continue
		}
		if visible && !canonicalRouteEntry(info) {
			continue
		}
		if len(synthetic.InfoByProvider) == 0 {
			synthetic.Info = info
		}
		synthetic.InfoByProvider[client] = info
		synthetic.Providers[client] = 1
	}
	result := commonModelInfo(synthetic)
	if result != nil {
		result.HideFromDiscovery = true
		for _, info := range synthetic.InfoByProvider {
			if !info.HideFromDiscovery {
				result.HideFromDiscovery = false
				break
			}
		}
	}
	return result
}
func (r *ModelRegistry) hasCanonicalLocked(id string) bool {
	for _, byID := range r.clientModelInfos {
		if info := byID[id]; info != nil && canonicalRouteEntry(info) {
			return true
		}
	}
	return false
}

// CanonicalRouteSource is per-credential, never a provider/global alias lookup.
// Exact override requests have no rewrite. Hidden entries remain callable.
func (r *ModelRegistry) CanonicalRouteSource(client, id string) string {
	r.mutex.RLock()
	defer r.mutex.RUnlock()
	if info := r.clientModelInfos[client][id]; info != nil {
		return info.CanonicalSourceID
	}
	return ""
}

// CanonicalOverrides exposes route IDs only, never credential indexes or secrets.
func (r *ModelRegistry) CanonicalOverrides(id string) []string {
	r.mutex.RLock()
	defer r.mutex.RUnlock()
	out := map[string]bool{}
	for _, byID := range r.clientModelInfos {
		for name, info := range byID {
			if info.HideFromDiscovery && info.CanonicalID == id && info.CanonicalOverride {
				out[name] = true
			}
		}
	}
	names := make([]string, 0, len(out))
	for name := range out {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

func canonicalRouteEntry(info *ModelInfo) bool {
	return info != nil && info.CanonicalID != "" && (!info.HideFromDiscovery || info.CanonicalPolicy == "free" || info.CanonicalPolicy == "paid")
}
func (r *ModelRegistry) CanonicalRouteInfos(id string) map[string]*ModelInfo {
	r.mutex.RLock()
	defer r.mutex.RUnlock()
	out := map[string]*ModelInfo{}
	for client, byID := range r.clientModelInfos {
		if info := byID[id]; info != nil && canonicalRouteEntry(info) {
			out[client] = cloneModelInfo(info)
		}
	}
	return out
}
