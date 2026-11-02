package executor

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/router-for-me/CLIProxyAPI/v8/internal/config"
	"gopkg.in/yaml.v3"
)

func TestConfiguredOpenAICompatRedirectBudget(t *testing.T) {
	for _, test := range []struct {
		name, executor string
		disable        bool
		want           int
	}{
		{"opt-in", "fixture", true, 0},
		{"default", "fixture", false, 1},
		{"unrelated", "other", true, 1},
	} {
		t.Run(test.name, func(t *testing.T) {
			var source, target atomic.Int32
			destination := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { target.Add(1); w.WriteHeader(200) }))
			defer destination.Close()
			origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				source.Add(1)
				w.Header().Set("Location", destination.URL)
				w.WriteHeader(http.StatusTemporaryRedirect)
			}))
			defer origin.Close()
			cfg := &config.Config{OpenAICompatibility: []config.OpenAICompatibility{{Name: "fixture", DisableRedirects: test.disable}}}
			executor := NewOpenAICompatExecutor(test.executor, cfg)
			response, err := executor.dispatchHTTPClient(context.Background(), nil, 0).Post(origin.URL, "application/json", strings.NewReader(`{"fixture":true}`))
			if err != nil {
				t.Fatal(err)
			}
			response.Body.Close()
			if source.Load() != 1 || int(target.Load()) != test.want {
				t.Fatalf("dispatches source=%d target=%d", source.Load(), target.Load())
			}
			if test.want == 0 && response.StatusCode != 307 {
				t.Fatal("redirect status lost")
			}
		})
	}
}

func TestNativeCompatibilityRedirectConfig(t *testing.T) {
	var cfg config.Config
	if err := yaml.Unmarshal([]byte("openai-compatibility:\n  - name: fixture\n    disable-redirects: true\n"), &cfg); err != nil {
		t.Fatal(err)
	}
	if len(cfg.OpenAICompatibility) != 1 || !cfg.OpenAICompatibility[0].DisableRedirects {
		t.Fatal("native config dropped redirect policy")
	}
}
