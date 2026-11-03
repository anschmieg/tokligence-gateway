package cliproxy

import (
	"crypto/sha256"
	"encoding/json"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/modelidentity"
	coreauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/config"
	"sort"
	"strings"
)

// canonicalizeRegisteredModels runs inside the existing fenced publication path.
// Originals remain registered for explicit overrides; visibility is discovery-only.
func (s *Service) canonicalizeRegisteredModels(cfg *config.Config, a *coreauth.Auth, models []*ModelInfo) []*ModelInfo {
	if cfg == nil || a == nil || !cfg.Models.CanonicalOnly {
		return models
	}
	var compat *config.OpenAICompatibility
	if _, name, ok := openAICompatInfoFromAuth(a); ok {
		compat = configEntryForAuthIndex(a, cfg.OpenAICompatibility)
		if compat == nil {
			for i := range cfg.OpenAICompatibility {
				if strings.EqualFold(cfg.OpenAICompatibility[i].Name, name) {
					compat = &cfg.OpenAICompatibility[i]
					break
				}
			}
		}
	}
	freeSources := map[string]bool{}
	catalogSources := map[string]bool{}
	requiresCatalog := compat != nil && compat.ModelDiscovery != nil && compat.ModelDiscovery.Enabled
	if compat != nil && compat.ModelDiscovery != nil && compat.ModelDiscovery.FreeOnly {
		s.catalogDiscovery.mu.RLock()
		snapshot := s.catalogDiscovery.snapshots[discoveryKey(compat)]
		for _, m := range snapshot.models {
			freeSources[m.ID] = true
		}
		for id := range snapshot.details {
			catalogSources[id] = true
		}
		s.catalogDiscovery.mu.RUnlock()
	}
	out := make([]*ModelInfo, 0, len(models)*2)
	original := map[string]*ModelInfo{}
	canonical := map[string]*ModelInfo{}
	for _, m := range models {
		if m == nil || m.ID == "" {
			continue
		}
		first := len(out)
		copy := cloneModelInfoForCatalogRoute(m)
		copy.HideFromDiscovery = true
		copy.CanonicalSourceID = ""
		copy.CanonicalPolicy = "override"
		out = append(out, &copy)
		original[m.ID] = &copy
		source := m.MetadataModelID
		if source == "" {
			source = m.ID
		}
		// Native auth prefixes are transport-only; plugin tags are removed by Name.
		if a != nil && a.Prefix != "" {
			source = strings.TrimPrefix(source, strings.TrimSuffix(a.Prefix, "/")+"/")
		}
		free := true
		if compat != nil {
			// Unknown native compatible pricing is conservative PAYGO. Free routes must
			// be backed by a successful free-admitted catalog in a fresh source snapshot.
			free = freeSources[source]

		}
		if compat == nil {
			switch a.Provider {
			case "freehub":
				free = false
				switch strings.ToLower(m.OwnedBy) {
				case "kilo", "openrouter", "cline", "zai", "llm7":
					free = true
				}
				for _, owner := range cfg.Models.FreeTierProviders {
					if strings.EqualFold(owner, "freehub:"+m.OwnedBy) {
						free = true
					}
				}
			case "gemini":
				free = a.AuthKind() != coreauth.AuthKindAPIKey
				if entry := resolveConfigGeminiKeyForConfig(cfg, a); entry != nil && entry.FreeTier {
					free = true
				}
			case "codex", "antigravity", "aistudio", "claude", "kimi", "meta", "xai":
				free = a.AuthKind() != coreauth.AuthKindAPIKey
			default:
				free = false
			}
		}
		label := strings.ToLower(a.Provider)
		if compat != nil {
			label = strings.ToLower(compat.Name)
			if a.Prefix != "" {
				label = strings.TrimSuffix(a.Prefix, "/")
			}
		}
		if a.Provider == "freehub" {
			label = strings.ToLower(m.OwnedBy)
		}
		label = strings.TrimSpace(label)
		if label != "" && !strings.Contains(label, ",") {
			override := label + "/" + modelidentity.TransportSource(source, m.OwnedBy)
			if override != m.ID {
				route := cloneModelInfoForCatalogRoute(m)
				route.ID = override
				route.Name = override
				route.HideFromDiscovery = true
				route.CanonicalSourceID = m.ID
				route.CanonicalOverride = true
				route.CanonicalPolicy = "override"
				route.CanonicalFree = free
				out = append(out, &route)
				original[override] = &route
			}
		}
		name := modelidentity.Name(source, m.OwnedBy, false)
		if name == "" {
			continue
		}
		for i := first; i < len(out); i++ {
			out[i].CanonicalID = name
			out[i].CanonicalFree = free
		}
		if requiresCatalog && !catalogSources[source] {
			continue
		} // Keep explicit override, but do not advertise a vanished/stale source.
		dispatchSource := m.ID
		if compat != nil {
			dispatchSource = source
		} // Stable upstream identity also preserves existing source cooldowns.
		candidate := cloneModelInfoForCatalogRoute(m)
		candidate.ID = name
		candidate.Name = name
		candidate.DisplayName = name
		candidate.HideFromDiscovery = false
		candidate.CanonicalID = name
		candidate.CanonicalOverride = false
		candidate.CanonicalPolicy = "canonical"
		candidate.CanonicalFree = free
		candidate.CanonicalSourceID = dispatchSource
		prev := canonical[name]
		if prev == nil || (free && !prev.CanonicalFree) || (free == prev.CanonicalFree && canonicalPreferSource(a.Provider, m.OwnedBy, dispatchSource, prev.CanonicalSourceID)) {
			canonical[name] = &candidate
		}
		policy := cloneModelInfoForCatalogRoute(&candidate)
		policy.HideFromDiscovery = true
		policy.CanonicalOverride = false
		if free {
			policy.ID = name + ":free"
			policy.CanonicalPolicy = "free"
		} else {
			policy.ID = name + ":paid"
			policy.CanonicalPolicy = "paid"
		}
		policy.Name = policy.ID
		policy.CanonicalSourceID = dispatchSource
		if prev := canonical[policy.ID]; prev == nil || canonicalPreferSource(a.Provider, m.OwnedBy, dispatchSource, prev.CanonicalSourceID) {
			canonical[policy.ID] = &policy
		}

	}
	for id, info := range canonical {
		if old := original[id]; old != nil {
			// Reserve a canonical spelling for its canonical target. A conflicting raw
			// spelling still has its provider-qualified override registered separately.
			*old = *info
		} else {
			out = append(out, info)
		}
	}
	// Deduplicate aliases introduced from both a bare and prefixed source. The
	// visible canonical entry wins; explicit generated override metadata wins over
	// a duplicate legacy hidden entry. No input slice/model is mutated.
	unique := map[string]*ModelInfo{}
	for _, m := range out {
		old := unique[m.ID]
		if old == nil || (old.HideFromDiscovery && !m.HideFromDiscovery) || (old.HideFromDiscovery && m.HideFromDiscovery && ((m.CanonicalPolicy == "free" || m.CanonicalPolicy == "paid") && old.CanonicalPolicy == "override" || m.CanonicalOverride && !old.CanonicalOverride && old.CanonicalPolicy == "override")) {
			unique[m.ID] = m
		}
	}
	ids := make([]string, 0, len(unique))
	for id := range unique {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	out = out[:0]
	for _, id := range ids {
		out = append(out, unique[id])
	}
	return out
}

func canonicalPolicySignature(cfg *config.Config) [32]byte {
	if cfg == nil {
		return [32]byte{}
	}
	flags := make([]bool, len(cfg.GeminiKey))
	for i, v := range cfg.GeminiKey {
		flags[i] = v.FreeTier
	}
	body, _ := json.Marshal(struct {
		Models any
		Gemini []bool
	}{cfg.Models, flags})
	return sha256.Sum256(body)
}

// Prefer plugin transport source IDs over equivalent display aliases so aliases
// cannot create a fresh availability key for an existing cooled source.
func canonicalPreferSource(provider, owner, next, previous string) bool {
	stable := func(id string) bool {
		return provider == "freehub" && strings.HasPrefix(strings.ToLower(id), strings.ToLower(owner)+"-")
	}
	if stable(next) != stable(previous) {
		return stable(next)
	}
	return previous == "" || next < previous
}
