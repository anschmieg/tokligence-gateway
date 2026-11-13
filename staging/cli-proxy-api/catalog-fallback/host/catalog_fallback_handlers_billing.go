package handlers

import (
	"context"
	"errors"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/interfaces"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/registry"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/thinking"
	"net/http"
	"strconv"
	"strings"
	"time"
)

func (h *BaseAPIHandler) canonicalPlan(ctx context.Context, model string, raw []byte, opts modelExecutionOptions, crossModel bool) (canonicalPlan, bool, *interfaces.ErrorMessage) {
	profile := registry.ModelProfileFromContext(ctx)
	parsed := thinking.ParseSuffix(model)
	name := strings.TrimSuffix(parsed.ModelName, ":free")
	// A named virtual profile is an explicit exception to exact-model semantics.
	// Never let it shadow a registered real canonical/qualified model.
	if profile == "" && h.AuthManager != nil && registry.GetGlobalRegistry().GetModelInfo(name, "") == nil {
		if _, ok := h.AuthManager.CanonicalRoutingPolicy().Profile(name); ok {
			profile = name
		}
	}
	if profile != "" {
		return h.profileCanonicalPlan(ctx, profile, model, raw, opts)
	}
	fail := func(code int, msg string) (canonicalPlan, bool, *interfaces.ErrorMessage) {
		return canonicalPlan{}, true, &interfaces.ErrorMessage{StatusCode: code, Error: errors.New(msg)}
	}
	if h.AuthManager == nil || !h.AuthManager.CanonicalRoutingEnabled() {
		return canonicalPlan{}, false, nil
	}
	if h.AuthManager.HomeEnabled() {
		return fail(503, "billing-governed routing unavailable in Home mode")
	}
	free := strings.HasSuffix(parsed.ModelName, ":free")
	if exact := registry.GetGlobalRegistry().GetModelInfo(parsed.ModelName, ""); exact != nil && exact.CanonicalPolicy == "override" {
		name = parsed.ModelName
	}
	selector := name
	canonical := registry.GetGlobalRegistry().GetModelInfo(name, "")
	if canonical == nil {
		return fail(404, "unknown gateway model")
	}
	canonicalID := canonical.CanonicalPolicy == "canonical" && canonical.CanonicalID == name
	r, e := canonicalRequestRequirements(raw)
	if e != nil {
		return fail(400, "invalid or ambiguous JSON request")
	}
	canonicalSuffixRequirements(model, &r)
	policy := registry.RequestBillingPolicy(ctx, "", free)
	if policy.Policy != registry.BillingPaid && r.UnverifiedCostFeatures {
		return fail(400, "unverified metered request features require explicit PAID policy")
	}
	p := canonicalPlan{Requested: model, Base: name, Policy: string(policy.Policy), Billing: policy.Policy, Limit: h.AuthManager.CanonicalRoutingPolicy().AttemptLimit(), Requirements: r, Suffix: strings.TrimPrefix(model, parsed.ModelName)}
	if t := registry.RoutingTraceFromContext(ctx); t != nil {
		t.Configure("", model, policy, free)
	}
	selectors := []string{selector}
	if canonicalID {
		selectors = []string{name + ":free", name + ":paid"}
	}
	p.Stages = h.billingStages(ctx, name, selectors, r, policy.Policy, false, nil)
	if len(p.Stages) == 0 {
		return fail(503, "no eligible route satisfies model and billing policy")
	}
	return p, true, nil
}
func (h *BaseAPIHandler) billingStages(ctx context.Context, model string, selectors []string, r canonicalRequirements, policy registry.BillingPolicy, alternative bool, planned map[string]registry.CanonicalDispatchBinding) []canonicalStage {
	out := []canonicalStage{}
	now := time.Now()
	for _, class := range []registry.BillingPolicy{registry.BillingFree, registry.BillingSub, registry.BillingPaid, registry.BillingUnknown} {
		if !policy.Allows(class) {
			continue
		}
		for _, selector := range selectors {
			allowed := map[string]bool{}
			bindings := map[string]registry.CanonicalDispatchBinding{}
			for id, info := range registry.GetGlobalRegistry().CanonicalRouteInfos(selector) {
				a, ok := h.AuthManager.GetByID(id)
				if !ok || h.AuthManager.CanonicalBillingClass(a, info, now) != class || !h.AuthManager.CanonicalBillingAvailable(id, selector, now, policy) {
					continue
				}
				if alternative && !canonicalBillingCompatible(info, r) {
					continue
				}
				b := registry.NewCanonicalDispatchBinding(id, selector, info)
				if planned != nil {
					old, ok := planned[id+"\x00"+selector]
					if !ok || old != b {
						continue
					}
				}
				allowed[id] = true
				bindings[id] = b
			}
			if len(allowed) > 0 {
				stage := canonicalStage{Model: selector, Allowed: allowed, PlannedBindings: bindings, Alternative: alternative, Billing: class}
				if class == registry.BillingPaid || class == registry.BillingUnknown {
					stage.Tier = 2
					out = append(out, stage)
					stage.Tier = 3
				}
				out = append(out, stage)
			}
		}
	}
	return out
}
func canonicalBillingCompatible(info *registry.ModelInfo, r canonicalRequirements) bool {
	if info == nil {
		return false
	}
	copy := *info
	copy.CanonicalFree = true
	return canonicalCompatible(&copy, r)
}
func billingResponseHeaders(headers http.Header, ctx context.Context, p canonicalPlan) http.Header {
	if headers == nil {
		headers = http.Header{}
	}
	headers.Set("X-Gateway-Billing-Policy", string(p.Billing))
	class := registry.BillingPolicy(headers.Get("X-Gateway-Billing-Class"))
	if class == "" {
		class = registry.BillingUnknown
	}
	if t := registry.RoutingTraceFromContext(ctx); t != nil {
		e := t.Snapshot()
		class = e.BillingClass
		headers.Set("X-Gateway-Policy-Version", strconv.FormatUint(e.PolicyVersion, 10))
		headers.Set("X-Gateway-Request-ID", e.RequestID)
		if e.Session != "" {
			headers.Set("X-Gateway-Session", e.Session)
		}
	}
	headers.Set("X-Gateway-Billing-Class", string(class))
	return headers
}

func (h *BaseAPIHandler) executeCountWithAuthManager(ctx context.Context, protocol, model string, raw []byte, alt string, opts modelExecutionOptions) ([]byte, http.Header, *interfaces.ErrorMessage) {
	if ctx == nil {
		ctx = context.Background()
	}
	ctx = registry.WithBoundModel(ctx)
	p, handled, invalid := h.canonicalPlan(ctx, model, raw, opts, false)
	if invalid != nil {
		return nil, nil, invalid
	}
	if !handled {
		return h.executeCanonicalCountAttempt(ctx, protocol, model, raw, alt, opts)
	}
	for _, stage := range p.Stages {
		selected := ""
		attempt, bindings := canonicalAttemptContextFor(registry.WithDispatchBilling(ctx, p.Billing), stage, p.Requirements, map[string]bool{}, map[string]bool{}, &selected, h.AuthManager)
		if len(bindings) == 0 {
			continue
		}
		body, headers, err := h.executeCanonicalCountAttempt(attempt, protocol, stage.Model+p.Suffix, canonicalBody(raw, stage.Model+p.Suffix), alt, opts)
		if err != nil {
			return nil, headers, err
		}
		return body, canonicalHeaders(headers, p, stage, selected, 1, bindings, ctx), nil
	}
	return nil, nil, &interfaces.ErrorMessage{StatusCode: 503, Error: errors.New("no eligible token counting route")}
}
