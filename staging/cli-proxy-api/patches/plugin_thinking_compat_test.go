package pluginhost

import (
	"context"
	"strings"
	"testing"

	"github.com/router-for-me/CLIProxyAPI/v8/internal/config"
	_ "github.com/router-for-me/CLIProxyAPI/v8/internal/translator"
	sdktranslator "github.com/router-for-me/CLIProxyAPI/v8/sdk/translator"
	"github.com/tidwall/gjson"
	"gopkg.in/yaml.v3"
)

func TestPluginUnsignedThinkingCompatibilityIsExplicitAndScoped(t *testing.T) {
	for _, test := range []struct {
		name, policy, pluginID string
		want                   bool
		bad                    bool
	}{
		{"enabled", "true", "fixture", true, false},
		{"default", "false", "fixture", false, false},
		{"other-plugin", "true", "other", false, false},
		{"invalid", "[]", "fixture", false, true},
	} {
		t.Run(test.name, func(t *testing.T) {
			var cfg config.Config
			if err := yaml.Unmarshal([]byte("plugins:\n  configs:\n    fixture:\n      enabled: true\n      preserve_unsigned_thinking: "+test.policy+"\n"), &cfg); err != nil {
				t.Fatal(err)
			}
			adapter := &executorAdapter{host: &Host{runtimeConfig: &cfg}, pluginID: test.pluginID}
			input := []byte(`{"model":"m","max_tokens":64,"messages":[{"role":"assistant","content":[{"type":"thinking","thinking":"fixture-reasoning"},{"type":"text","text":"fixture-text"},{"type":"tool_use","id":"call_x","name":"lookup","input":{"key":"x"}}]},{"role":"user","content":[{"type":"tool_result","tool_use_id":"call_x","content":"result"}]}]}`)
			out := adapter.translateConfiguredPluginRequest(context.Background(), sdktranslator.FormatClaude, sdktranslator.FormatOpenAI, sdktranslator.RequestEnvelope{Model: "m", Body: input})
			if test.bad {
				if out.Err == nil {
					t.Fatal("invalid policy accepted")
				}
				return
			}
			if out.Err != nil {
				t.Fatal(out.Err)
			}
			found := gjson.GetBytes(out.Body, "messages.0.reasoning_content").String() == "fixture-reasoning"
			if found != test.want {
				t.Fatalf("reasoning retained=%v want=%v", found, test.want)
			}
			for _, value := range []string{"fixture-text", "call_x", "lookup", "result"} {
				if !strings.Contains(string(out.Body), value) {
					t.Fatalf("lost %s", value)
				}
			}
		})
	}
}
