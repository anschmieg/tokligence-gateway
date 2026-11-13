package registry

import (
	"slices"
	"testing"
)

func TestCatalogSharedContractIsIntersection(t *testing.T) {
	a := &ModelInfo{ID: "shared", OwnedBy: "a", ContextLength: 1000, MaxCompletionTokens: 100, SupportedParameters: []string{"tools", "temperature"}, SupportedInputModalities: []string{"text", "image"}, Thinking: &ThinkingSupport{Levels: []string{"low", "high"}}}
	b := &ModelInfo{ID: "shared", OwnedBy: "b", ContextLength: 500, MaxCompletionTokens: 0, SupportedParameters: []string{"temperature"}, SupportedInputModalities: []string{"text"}}
	r := &ModelRegistration{Info: a, InfoByProvider: map[string]*ModelInfo{"a": a, "b": b}, Providers: map[string]int{"a": 1, "b": 1}}
	got := commonModelInfo(r)
	if got.ContextLength != 500 || got.MaxCompletionTokens != 0 || got.Thinking != nil || !slices.Equal(got.SupportedParameters, []string{"temperature"}) || !slices.Equal(got.SupportedInputModalities, []string{"text"}) {
		t.Fatal(got)
	}
	if a.ContextLength != 1000 || len(a.SupportedParameters) != 2 {
		t.Fatal("input mutated")
	}
}
func TestCatalogUnknownIsNotInvented(t *testing.T) {
	r := GetGlobalRegistry()
	id := "fixture-catalog-unknown"
	r.RegisterClient(id, "fixture", []*ModelInfo{{ID: id, OwnedBy: "fixture"}})
	defer r.UnregisterClient(id)
	got := CatalogMetadata(id)
	if _, ok := got["context_length"]; ok {
		t.Fatal(got)
	}
	caps := got["capabilities"].(map[string]any)
	if caps["reasoning"] != nil || caps["tools"] != nil {
		t.Fatal(got)
	}
}
