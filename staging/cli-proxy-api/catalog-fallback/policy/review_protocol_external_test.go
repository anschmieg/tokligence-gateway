package catalogfallback_test

import (
	"github.com/router-for-me/CLIProxyAPI/v8/internal/catalogfallback"
	nativeClaude "github.com/router-for-me/CLIProxyAPI/v8/internal/translator/claude/openai/chat-completions"
	"github.com/tidwall/gjson"
	"testing"
)

func TestRegressionDuplicateProtocolControlsRefused(t *testing.T) {
	raw := []byte(`{"messages":[{"role":"user","content":"x"}],"tools":[{"type":"function","function":{"name":"x","parameters":{"type":"object"}}}],"tools":[]}`)
	r, err := catalogfallback.RequirementsFromJSON(raw)
	translated, translateErr := nativeClaude.ConvertOpenAIRequestToClaude("fixture-model", raw, false)
	if translateErr != nil {
		t.Fatal(translateErr)
	}
	count := gjson.GetBytes(translated, "tools.#").Int()
	t.Logf("router_tools=%v native_translated_tools=%d parse_error=%v", r.Tools, count, err)
	if err == nil && count > 0 && !r.Tools {
		t.Fatal("last-wins router under-admits a first-wins native translator request")
	}
}
