package cline

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"
)

// ModelEntry is one free-model fixture from the plugin configuration
// (plugins.configs.cline.models). It mirrors the shape the gateway consumed
// from the Cline recommended-models feed.
type ModelEntry struct {
	ID          string `json:"id"`
	DisplayName string `json:"display_name,omitempty"`
	Description string `json:"description,omitempty"`
}

// PluginModels is the model registrar response payload.
type PluginModels struct {
	Provider string            `json:"provider"`
	Models   []RegisteredModel `json:"models"`
}

// RegisteredModel matches the pluginapi.ModelInfo JSON fields used by the host.
type RegisteredModel struct {
	ID          string `json:"ID"`
	Object      string `json:"Object,omitempty"`
	Created     int64  `json:"Created,omitempty"`
	OwnedBy     string `json:"OwnedBy,omitempty"`
	Type        string `json:"Type,omitempty"`
	DisplayName string `json:"DisplayName,omitempty"`
	Description string `json:"Description,omitempty"`
}

// ParseModelConfig decodes the configured model fixtures and returns the
// normalized host-visible catalog. Ids are mapped to cline/ prefixed public
// ids; duplicates (case-insensitive) are dropped.
func ParseModelConfig(raw []byte) ([]RegisteredModel, error) {
	if len(strings.TrimSpace(string(raw))) == 0 {
		return nil, fmt.Errorf("cline plugin requires a models configuration")
	}
	var entries []ModelEntry
	if err := json.Unmarshal(raw, &entries); err != nil {
		return nil, fmt.Errorf("cline models configuration is invalid: %w", err)
	}
	seen := map[string]struct{}{}
	models := make([]RegisteredModel, 0, len(entries))
	for _, entry := range entries {
		id := strings.TrimSpace(entry.ID)
		if id == "" {
			continue
		}
		publicID := PublicModelID(id)
		key := strings.ToLower(publicID)
		if _, exists := seen[key]; exists {
			continue
		}
		seen[key] = struct{}{}
		display := strings.TrimSpace(entry.DisplayName)
		if display == "" {
			display = publicID
		}
		models = append(models, RegisteredModel{
			ID:          publicID,
			Object:      "model",
			Created:     time.Now().UTC().Unix(),
			OwnedBy:     ProviderKey,
			Type:        "chat",
			DisplayName: display,
			Description: strings.TrimSpace(entry.Description),
		})
	}
	if len(models) == 0 {
		return nil, fmt.Errorf("cline models configuration contains no models")
	}
	sort.Slice(models, func(i, j int) bool { return models[i].ID < models[j].ID })
	return models, nil
}

// ModelCatalog holds the parsed static catalog for the plugin instance.
type ModelCatalog struct {
	Models []RegisteredModel
}

// Contains reports whether the catalog has the given public model id.
func (c *ModelCatalog) Contains(publicID string) bool {
	if c == nil {
		return false
	}
	target := strings.ToLower(strings.TrimSpace(publicID))
	for _, model := range c.Models {
		if strings.ToLower(model.ID) == target {
			return true
		}
	}
	return false
}
