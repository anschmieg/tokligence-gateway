package auth

import internalconfig "github.com/router-for-me/CLIProxyAPI/v8/internal/config"

// Configured aliases use native reverse mapping. Discovery publishes them only
// for fresh eligible sources; explicit operator aliases always take precedence.
func discoveryModelAliasEntries(entry *internalconfig.OpenAICompatibility) []modelAliasEntry {
	models := asModelAliasEntries(entry.Models)
	if entry.ModelDiscovery == nil || !entry.ModelDiscovery.Enabled || !entry.ModelDiscovery.FreeOnly {
		return models
	}
	for _, candidate := range entry.ModelDiscovery.Aliases {
		overridden := false
		for _, manual := range entry.Models {
			if manual.Alias == candidate.Alias || manual.Name == candidate.Alias {
				overridden = true
				break
			}
		}
		for _, other := range entry.ModelDiscovery.Aliases {
			if other.Alias == candidate.Alias && other.Name != candidate.Name {
				overridden = true
				break
			}
		}
		if !overridden {
			models = append(models, asModelAliasEntries([]internalconfig.OpenAICompatibilityModel{candidate})...)
		}
	}
	return models
}
