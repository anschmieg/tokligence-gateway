package helps

import (
	coreauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func TestNativeOAuthBudgetRejectsRedirect(t *testing.T) {
	for _, provider := range []string{"antigravity", "codex", "other"} {
		t.Run(provider, func(t *testing.T) {
			var originHits, targetHits atomic.Int64
			target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { targetHits.Add(1) }))
			defer target.Close()
			origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { originHits.Add(1); http.Redirect(w, r, target.URL, 307) }))
			defer origin.Close()
			original := &http.Client{}
			client := NativeOAuthBudgetClient(original, &coreauth.Auth{Provider: provider})
			response, err := client.Post(origin.URL, "application/json", strings.NewReader(`{"fixture":true}`))
			if err != nil {
				t.Fatal(err)
			}
			response.Body.Close()
			if originHits.Load() != 1 {
				t.Fatal("origin count differs")
			}
			if provider == "other" {
				if client != original || targetHits.Load() != 1 {
					t.Fatal("unrelated policy changed")
				}
			} else if client == original || targetHits.Load() != 0 || response.StatusCode != 307 || original.CheckRedirect != nil {
				t.Fatal("redirect budget or original client changed")
			}
		})
	}
}
