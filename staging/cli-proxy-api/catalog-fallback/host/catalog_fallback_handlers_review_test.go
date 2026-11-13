package handlers

import (
	"context"
	"strings"
	"testing"

	"github.com/router-for-me/CLIProxyAPI/v8/internal/registry"
)

func TestRegressionPaidOnlyModelCanHaveFreeAlternative(t *testing.T) {
	h, e := profileFixture(t, map[string]int{})
	reg := registry.GetGlobalRegistry()
	reg.UnregisterClient("cf-kilo")
	reg.UnregisterClient("cf-other")
	if len(reg.CanonicalRouteInfos("glm-5.3-flash:free")) != 0 {
		t.Fatal("fixture still has direct free route")
	}
	p, handled, invalid := h.canonicalPlan(registry.WithModelProfile(context.Background(), "coding"), "glm-5.3-flash:free", []byte(`{"model":"glm-5.3-flash:free"}`), modelExecutionOptions{}, true)
	t.Logf("handled=%v invalid=%v planned_stages=%+v", handled, invalid, p.Stages)
	if !handled || invalid != nil || len(p.Stages) != 1 {
		t.Fatal("fixture did not construct free alternative")
	}
	_, headers, err := h.ExecuteWithAuthManager(registry.WithModelProfile(context.Background(), "coding"), "openai", "glm-5.3-flash:free", []byte(`{"model":"glm-5.3-flash:free","messages":[{"role":"user","content":"x"}],"max_tokens":20}`), "")
	t.Logf("direct_free_routes=0 calls=%v resolved=%q error=%v", e.calls, headers.Get("X-Gateway-Resolved-Model"), err)
	if err != nil || len(e.calls) != 1 || !strings.HasPrefix(e.calls[0], "cf-alt/") || headers.Get("X-Gateway-Cost-Policy") != "FREE" {
		t.Fatal(err, e.calls, headers)
	}
}
