package models

import "github.com/router-for-me/CLIProxyAPI/v8/internal/registry"

// Native Codex templates remain native. Foreign models must not inherit their
// reasoning efforts, parallel-tools promise or unknown token ceilings.
func applyDisclosedCatalogMetadata(entries []map[string]any) {
	for _, entry := range entries {
		id, _ := entry["slug"].(string)
		info := registry.GetGlobalRegistry().GetModelInfo(id, "")
		if info == nil {
			continue
		}
		providers := registry.GetGlobalRegistry().GetModelProviders(id)
		if len(providers) == 1 && providers[0] == "codex" {
			continue
		}
		entry["catalog_metadata"] = registry.CatalogMetadata(id)
		entry["supports_parallel_tool_calls"] = false
		if info.Thinking == nil || (info.UserDefined && !info.ExplicitThinking) {
			entry["supported_reasoning_levels"] = []any{}
			delete(entry, "default_reasoning_level")
		}
		if info.ContextLength <= 0 {
			delete(entry, "context_window")
			delete(entry, "max_context_window")
		}
		if info.MaxCompletionTokens <= 0 {
			delete(entry, "max_tokens")
		}
	}
}
