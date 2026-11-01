package opencode

import (
	"fmt"
	"sort"
	"strings"
)

// RegisteredModel matches the pluginapi.ModelInfo JSON fields used by the
// host (untagged Go struct fields marshal with their exact names, the same
// convention the cline plugin uses against the same host build).
type RegisteredModel struct {
	ID                         string   `json:"ID"`
	Object                     string   `json:"Object,omitempty"`
	OwnedBy                    string   `json:"OwnedBy,omitempty"`
	Type                       string   `json:"Type,omitempty"`
	DisplayName                string   `json:"DisplayName,omitempty"`
	Name                       string   `json:"Name,omitempty"`
	SupportedGenerationMethods []string `json:"SupportedGenerationMethods,omitempty"`
	SupportedParameters        []string `json:"SupportedParameters,omitempty"`
	SupportedInputModalities   []string `json:"SupportedInputModalities,omitempty"`
	SupportedOutputModalities  []string `json:"SupportedOutputModalities,omitempty"`
}

// PluginModels is the model registrar / models-for-auth response payload.
type PluginModels struct {
	Provider string            `json:"Provider"`
	Models   []RegisteredModel `json:"Models"`
}

// BuildModelCatalog turns the configured allowlist into the host catalog.
// The published ids are bare upstream ids: the host's model routing already
// serves provider aliases, and the native catalog serves unprefixed ids.
func BuildModelCatalog(cfg PluginConfig) ([]RegisteredModel, error) {
	if len(cfg.Models) == 0 {
		return nil, fmt.Errorf("opencode plugin requires a models configuration")
	}
	models := make([]RegisteredModel, 0, len(cfg.Models))
	for _, id := range cfg.Models {
		models = append(models, RegisteredModel{
			ID:                         id,
			Object:                     "model",
			OwnedBy:                    ProviderKey,
			Type:                       "chat",
			DisplayName:                id,
			Name:                       id,
			SupportedGenerationMethods: []string{"chat/completions"},
			SupportedParameters:        []string{"stream", "stream_options", "tools", "tool_choice", "messages", "max_tokens", "max_completion_tokens", "temperature", "top_p", "reasoning_effort"},
			SupportedInputModalities:   []string{"text"},
			SupportedOutputModalities:  []string{"text"},
		})
	}
	sort.Slice(models, func(i, j int) bool { return models[i].ID < models[j].ID })
	return models, nil
}

// containsModel reports whether the catalog has the bare model id.
func containsModel(models []RegisteredModel, model string) bool {
	model = strings.TrimSpace(model)
	if model == "" {
		return false
	}
	for _, entry := range models {
		if entry.ID == model {
			return true
		}
	}
	return false
}
