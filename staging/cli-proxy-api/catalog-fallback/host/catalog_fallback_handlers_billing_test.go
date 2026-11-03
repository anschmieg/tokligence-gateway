package handlers

import (
	"context"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/registry"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/config"
	"strings"
	"testing"
	"time"
)

func billingContext(t *testing.T, policy registry.BillingPolicy, profile string) context.Context {
	t.Helper()
	s := registry.NewRoutingStore()
	a, _ := s.Capture("fixture", "session", "")
	s.Set(a, profile, policy)
	a, _ = s.Capture("fixture", "session", "")
	ctx := registry.WithBillingAdmission(context.Background(), a)
	if profile != "" {
		ctx = registry.WithModelProfile(ctx, profile)
	}
	return ctx
}

const billingRaw = `{"model":"glm-5.3-flash","messages":[{"role":"user","content":"code"}],"max_tokens":20}`

func TestSessionDefaultSubNormalModelBindingAndExplicitPaid(t *testing.T) {
	h, e := profileFixture(t, map[string]int{"cf-kilo": 503, "cf-other": 503})
	_, _, err := h.ExecuteWithAuthManager(context.Background(), "openai", "glm-5.3-flash", []byte(billingRaw), "")
	if err == nil || len(e.calls) != 2 {
		t.Fatal(err, e.calls)
	}
	for _, call := range e.calls {
		if strings.Contains(call, "cf-paid") || strings.Contains(call, "cf-alt") {
			t.Fatal("normal model or billing escaped", e.calls)
		}
	}
	h, e = profileFixture(t, map[string]int{"cf-kilo": 503, "cf-other": 503})
	_, headers, err := h.ExecuteWithAuthManager(billingContext(t, registry.BillingPaid, ""), "openai", "glm-5.3-flash", []byte(billingRaw), "")
	if err != nil || len(e.calls) != 3 || !strings.HasPrefix(e.calls[2], "cf-paid/") || headers.Get("X-Gateway-Billing-Class") != "PAID" {
		t.Fatal(err, e.calls, headers)
	}
}
func TestSessionProfilePaidModelFirstAndFreeSuffixRestriction(t *testing.T) {
	h, e := profileFixture(t, map[string]int{"cf-kilo": 503, "cf-other": 503})
	_, headers, err := h.ExecuteWithAuthManager(billingContext(t, registry.BillingPaid, "coding"), "openai", "glm-5.3-flash", []byte(billingRaw), "")
	if err != nil || len(e.calls) != 3 || !strings.HasPrefix(e.calls[2], "cf-paid/") || headers.Get("X-Gateway-Profile") != "coding" {
		t.Fatal(err, e.calls, headers)
	}
	h, e = profileFixture(t, map[string]int{"cf-kilo": 503, "cf-other": 503})
	_, headers, err = h.ExecuteWithAuthManager(billingContext(t, registry.BillingPaid, "coding"), "openai", "glm-5.3-flash:free", []byte(billingRaw), "")
	if err != nil || len(e.calls) != 3 || !strings.HasPrefix(e.calls[2], "cf-alt/") || headers.Get("X-Gateway-Billing-Policy") != "FREE" {
		t.Fatal(err, e.calls, headers)
	}
}
func TestSessionVerifiedSubscriptionIsSubNotFree(t *testing.T) {
	for _, policy := range []registry.BillingPolicy{registry.BillingSub, registry.BillingFree} {
		h, e := profileFixture(t, map[string]int{"cf-kilo": 503})
		models := registry.GetGlobalRegistry().GetModelsForClient("cf-other")
		for _, m := range models {
			m.PluginCostTier = "included"
		}
		registry.GetGlobalRegistry().RegisterClient("cf-other", e.Identifier(), models)
		p := h.AuthManager.CanonicalRoutingPolicy()
		p.NoChargeAllowances = []registry.NoChargeAllowance{{Provider: e.Identifier(), AuthID: "cf-other", SourceModels: []string{"upstream-glm-5.3-flash"}, Basis: "fixture no-overage proof", VerifiedUntil: time.Now().Add(time.Hour).UTC().Format(time.RFC3339), NoPaidOverage: true}}
		h.AuthManager.SetConfig(&config.Config{Models: registry.CatalogSources{CanonicalOnly: true, CanonicalRouting: p}})
		_, headers, err := h.ExecuteWithAuthManager(billingContext(t, policy, ""), "openai", "glm-5.3-flash", []byte(billingRaw), "")
		if policy == registry.BillingSub {
			if err != nil || len(e.calls) != 2 || headers.Get("X-Gateway-Billing-Class") != "SUB" {
				t.Fatal(err, e.calls, headers)
			}
		} else if err == nil || len(e.calls) != 1 {
			t.Fatal("FREE used included allowance", err, e.calls)
		}
	}
}
func TestSessionVirtualProfileAliasAndBindingSuffix(t *testing.T) {
	h, e := profileFixture(t, nil)
	_, headers, err := h.ExecuteWithAuthManager(context.Background(), "openai", "chat", []byte(`{"model":"chat","messages":[{"role":"user","content":"hi"}]}`), "")
	if err != nil || len(e.calls) != 1 || headers.Get("X-Gateway-Profile") != "chat" {
		t.Fatal(err, e.calls, headers)
	}
	h, e = profileFixture(t, map[string]int{"cf-kilo": 503, "cf-other": 503})
	_, _, err = h.ExecuteWithAuthManager(billingContext(t, registry.BillingPaid, ""), "openai", "glm-5.3-flash:free", []byte(billingRaw), "")
	if err == nil || len(e.calls) != 2 {
		t.Fatal("normal suffix switched model or billed", err, e.calls)
	}
}
func TestSessionCompactionCannotSwitchModels(t *testing.T) {
	h, e := profileFixture(t, map[string]int{"cf-kilo": 503, "cf-other": 503})
	ctx := registry.WithModelProfile(context.Background(), "coding")
	_, _, err := h.ExecuteWithAuthManager(ctx, "openai", "glm-5.3-flash", []byte(billingRaw), "responses/compact")
	if err == nil || len(e.calls) != 2 {
		t.Fatal("compaction changed model", err, e.calls)
	}
	for _, call := range e.calls {
		if strings.HasPrefix(call, "cf-alt/") {
			t.Fatal(call)
		}
	}
}
func TestSessionPaidFeaturesDoNotMisreportFreeServingClass(t *testing.T) {
	h, e := profileFixture(t, nil)
	ctx := billingContext(t, registry.BillingPaid, "")
	a := registry.BillingAdmissionFromContext(ctx)
	trace := a.Store.Begin(a, registry.RoutingEvent{Kind: "main"})
	ctx = registry.WithRoutingTrace(ctx, trace)
	_, headers, err := h.ExecuteWithAuthManager(ctx, "openai", "glm-5.3-flash", []byte(`{"model":"glm-5.3-flash","messages":[{"role":"user","content":"code"}],"tools":[{"type":"web_search"}]}`), "")
	if err != nil || len(e.calls) != 1 || headers.Get("X-Gateway-Billing-Class") != "UNKNOWN" {
		t.Fatal(err, e.calls, headers)
	}
}
