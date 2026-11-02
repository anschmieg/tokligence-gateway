package pluginhost

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func TestProviderDispatchBudget(t *testing.T) {
	for _, provider := range []string{"opencode", "cline", "freehub", "free-model-hub", " OPENCODE ", "unrelated"} {
		t.Run(provider, func(t *testing.T) {
			var originCalls, targetCalls, policyCalls atomic.Int64
			target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				targetCalls.Add(1)
				w.WriteHeader(200)
			}))
			defer target.Close()
			origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				originCalls.Add(1)
				http.Redirect(w, r, target.URL, http.StatusTemporaryRedirect)
			}))
			defer origin.Close()
			original := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error {
				policyCalls.Add(1)
				return nil
			}}
			client := providerDispatchClient(original, provider)
			response, err := client.Post(origin.URL, "application/json", strings.NewReader(`{"fixture":true}`))
			if err != nil {
				t.Fatal(err)
			}
			_, _ = io.Copy(io.Discard, response.Body)
			_ = response.Body.Close()
			if originCalls.Load() != 1 {
				t.Fatal("origin called more than once")
			}
			if provider == "unrelated" {
				if client != original || response.StatusCode != 200 || targetCalls.Load() != 1 || policyCalls.Load() != 1 {
					t.Fatal("unrelated provider policy changed")
				}
			} else {
				if client == original || response.StatusCode != 307 || targetCalls.Load() != 0 || policyCalls.Load() != 0 {
					t.Fatal("custom provider followed redirect")
				}
				// The original object's policy must still be intact.
				if err := original.CheckRedirect(nil, nil); err != nil || policyCalls.Load() != 1 {
					t.Fatal("shared client was mutated")
				}
			}
		})
	}
}
