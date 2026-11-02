package openaicompat

import (
	"slices"
	"testing"
)

func TestCatalogMetadataPreservesSourceAndUnknown(t *testing.T) {
	models, err := parseModels([]byte(`{"data":[{"id":"google/lyria-3-clip-preview","context_length":1048576,"top_provider":{"max_completion_tokens":65536},"supported_parameters":["max_tokens","temperature"],"architecture":{"input_modalities":["text","image"],"output_modalities":["text","audio"]}},{"id":"unknown-model"}]}`))
	if err != nil {
		t.Fatal(err)
	}
	a := &adapter{provider: Provider{ID: "fixture", Name: "Fixture"}}
	out := a.toModelInfo(models)
	if len(out) != 2 {
		t.Fatal(out)
	}
	m := out[0]
	if m.ContextLength != 1048576 || m.MaxCompletionTokens != 65536 || m.OwnedBy != "fixture" {
		t.Fatal(m)
	}
	if slices.Contains(m.SupportedParameters, "tools") || !slices.Contains(m.SupportedOutputModalities, "audio") {
		t.Fatal(m)
	}
	if !slices.Equal(m.SupportedGenerationMethods, []string{"generateContent"}) {
		t.Fatal(m)
	}
	unknown := out[1]
	if unknown.ContextLength != 0 || unknown.MaxCompletionTokens != 0 || len(unknown.SupportedParameters) != 0 || unknown.Thinking != nil {
		t.Fatal(unknown)
	}
}

func TestCatalogToolsAreExplicit(t *testing.T) {
	models, err := parseModels([]byte(`[{"id":"known","supported_parameters":["tools","tool_choice","reasoning"]}]`))
	if err != nil {
		t.Fatal(err)
	}
	a := &adapter{provider: Provider{ID: "fixture"}}
	got := a.toModelInfo(models)[0]
	if !slices.Contains(got.SupportedParameters, "tools") || got.Thinking != nil {
		t.Fatal(got)
	}
}
