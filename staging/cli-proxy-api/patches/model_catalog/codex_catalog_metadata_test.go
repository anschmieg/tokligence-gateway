package models

import (
	"github.com/router-for-me/CLIProxyAPI/v8/internal/registry"
	"testing"
)

func TestForeignCatalogDoesNotInheritCodexOptions(t *testing.T) {
	r := registry.GetGlobalRegistry()
	id := "fixture-foreign-catalog"
	r.RegisterClient(id, "freehub", []*registry.ModelInfo{{ID: id, OwnedBy: "kilo"}})
	defer r.UnregisterClient(id)
	entries := []map[string]any{{"slug": id, "context_window": 1000000, "max_context_window": 1000000, "max_tokens": 16384, "supported_reasoning_levels": []any{"ultra"}, "default_reasoning_level": "ultra", "supports_parallel_tool_calls": true}}
	applyDisclosedCatalogMetadata(entries)
	got := entries[0]
	if _, ok := got["context_window"]; ok {
		t.Fatal(got)
	}
	if _, ok := got["max_tokens"]; ok {
		t.Fatal(got)
	}
	if _, ok := got["default_reasoning_level"]; ok {
		t.Fatal(got)
	}
	if len(got["supported_reasoning_levels"].([]any)) != 0 || got["supports_parallel_tool_calls"] != false {
		t.Fatal(got)
	}
}
