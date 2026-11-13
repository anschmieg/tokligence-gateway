package catalogfallback

import "testing"

func TestDraftProtocolScopedHistoryAndOpaqueFields(t *testing.T) {
	tests := []struct {
		body          string
		opaque, tools bool
	}{
		{`{"messages":[{"role":"assistant","tool_calls":[{"function":{"name":"x","arguments":"{}","extra_content":{"google":{"thought_signature":"fixture"}}}}]}]}`, true, true},
		{`{"messages":[{"role":"assistant","content":[{"type":"thinking","signature":"fixture"}]}]}`, true, false},
		{`{"input":[{"type":"reasoning","id":"rs_fixture","summary":[]}]}`, true, false},
		{`{"previous_response_id":"resp_fixture"}`, true, false},
		{`{"conversation":{"id":"conv_fixture"}}`, true, false},
		{`{"contents":[{"role":"model","parts":[{"thoughtSignature":"fixture"}]}]}`, true, false},
		{`{"messages":[{"role":"assistant","reasoning_details":[{"type":"reasoning.encrypted","data":"fixture"}]}]}`, true, false},
		{`{"tools":[{"type":"function","function":{"parameters":{"properties":{"fileData":{"type":"string"},"signature":{"type":"string"}}}}}],"messages":[{"role":"user","content":"plain text"}]}`, false, true},
		{`{"contents":[{"role":"user","parts":[{"functionResponse":{"name":"x","response":{"fileData":"user result data","signature":"also just data"}}}]}]}`, false, true},
	}
	for _, tt := range tests {
		r, err := RequirementsFromJSON([]byte(tt.body))
		if err != nil || r.OpaqueState != tt.opaque || r.Tools != tt.tools {
			t.Fatal(tt.body, r, err)
		}
		if !tt.opaque && r.Modalities["file"] {
			t.Fatal("tool data/schema treated as media", r)
		}
	}
}
func TestDraftExactReasoningAndStructuredOutput(t *testing.T) {
	c := fixtureCaps()
	c.ReasoningLevels = []string{"low"}
	r, err := RequirementsFromJSON([]byte(`{"reasoning_effort":"high","max_tokens":20}`))
	if err != nil || Compatible(c, r) {
		t.Fatal(r, err)
	}
	r, err = RequirementsFromJSON([]byte(`{"thinking":{"type":"enabled","budget_tokens":8192}}`))
	if err != nil || Compatible(c, r) {
		t.Fatal(r, err)
	}
	r, err = RequirementsFromJSON([]byte(`{"response_format":{"type":"json_schema","json_schema":{"name":"x"}}}`))
	c.StructuredJSON = false
	if err != nil || Compatible(c, r) {
		t.Fatal(r, err)
	}
	r, err = RequirementsFromJSON([]byte(`{"generationConfig":{"thinkingConfig":{"thinkingLevel":"high"},"maxOutputTokens":100}}`))
	if err != nil || Compatible(c, r) {
		t.Fatal(r, err)
	}
}
func TestDraftUnenumeratedReasoningLevelsAreUnknownNotUnsupported(t *testing.T) {
	// Catalog rows derived from models.dev declare reasoning support through
	// supported_parameters while publishing no thinking block, so the level list
	// is empty. That means the levels were never enumerated, not that none exist.
	r, err := RequirementsFromJSON([]byte(`{"output_config":{"effort":"high"},"max_tokens":20}`))
	if err != nil || r.ReasoningEffort != "high" || !r.Reasoning {
		t.Fatal(r, err)
	}
	undeclared := fixtureCaps()
	undeclared.ReasoningLevels = nil
	if !Compatible(undeclared, r) {
		t.Fatal("model declaring reasoning support rejected for an unenumerated effort", r)
	}
	known := fixtureCaps()
	known.ReasoningLevels = []string{"low"}
	if Compatible(known, r) {
		t.Fatal("known level list must still reject an unlisted effort", r)
	}
}
func TestDraftInvalidBudgetsAndTrailingJSON(t *testing.T) {
	for _, raw := range []string{`{"max_tokens":1e100}`, `{"max_tokens":-1}`, `{"max_tokens":1.5}`, `{} trailing`, `{} {}`, `[]`} {
		if _, err := RequirementsFromJSON([]byte(raw)); err == nil {
			t.Fatal(raw)
		}
	}
}
func TestDraftToolHistoryPreservedWithoutToolDefinitions(t *testing.T) {
	r, err := RequirementsFromJSON([]byte(`{"messages":[{"role":"assistant","tool_calls":[{"id":"x","function":{"name":"read_file","arguments":"{}"}}]},{"role":"tool","tool_call_id":"x","content":"ok"}]}`))
	if err != nil || !r.Tools || !r.Continuity || r.Task != Agent || r.OpaqueState {
		t.Fatal(r, err)
	}
}
