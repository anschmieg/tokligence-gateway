package auth

import (
	"context"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/registry"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/thinking"
	cliproxyexecutor "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/executor"
	"strings"
)

func canonicalOneDispatch(meta map[string]any) bool {
	v, _ := meta["gateway.canonical_dispatch"].(bool)
	return v
}
func canonicalAttemptExclusions(meta map[string]any) []string {
	v, _ := meta["gateway.canonical_excluded_auths"].([]string)
	return v
}
func (m *Manager) CanonicalRoutingPolicy() registry.CanonicalRoutingConfig {
	cfg := m.runtimeConfigSnapshot()
	if cfg == nil {
		return registry.CanonicalRoutingConfig{}
	}
	p := cfg.Models.CanonicalRouting
	if p.FreeFallbacks != nil {
		out := map[string][]string{}
		for k, v := range p.FreeFallbacks {
			out[k] = append([]string{}, v...)
		}
		p.FreeFallbacks = out
	}
	return p
}

// Once registered as canonical, a target is final: no second alias or pool pass.
func canonicalPinnedModel(a *Auth, route string) (string, bool) {
	if a == nil {
		return "", false
	}
	base := thinking.ParseSuffix(route).ModelName
	info := registry.GetGlobalRegistry().CanonicalRouteInfos(base)[a.ID]
	if info == nil || info.CanonicalSourceID == "" {
		return "", false
	}
	return preserveRequestedModelSuffix(route, info.CanonicalSourceID), true
}
func validateCanonicalDispatch(a *Auth, req cliproxyexecutor.Request, opts *cliproxyexecutor.Options) error {
	if !canonicalOneDispatch(opts.Metadata) {
		return nil
	}
	refused := func() error {
		return &Error{Code: "canonical_admission_changed", Message: "canonical target admission changed; request was not dispatched", HTTPStatus: 409}
	}
	route, _ := opts.Metadata["gateway.canonical_route"].(string)
	bindings, ok := opts.Metadata["gateway.canonical_bindings"].(map[string]registry.CanonicalDispatchBinding)
	if !ok || a == nil {
		return refused()
	}
	bound, ok := bindings[a.ID]
	if !ok || bound.AuthID != a.ID || bound.Route != route {
		return refused()
	}
	current := registry.GetGlobalRegistry().CanonicalRouteInfos(route)[a.ID]
	if current == nil || registry.NewCanonicalDispatchBinding(a.ID, route, current) != bound {
		return refused()
	}
	if strings.HasSuffix(route, ":free") && !bound.Free {
		return refused()
	}
	if thinking.ParseSuffix(req.Model).ModelName != bound.Source {
		return refused()
	}
	permit, _ := opts.Metadata["gateway.canonical_permit"].(*registry.CanonicalDispatchPermit)
	if !permit.Claim() {
		return &Error{Code: "canonical_dispatch_budget", Message: "canonical physical dispatch permit already consumed", HTTPStatus: 409}
	}
	opts.Metadata["gateway.canonical_source_model"] = bound.PluginSource
	opts.Metadata["gateway.canonical_cost_tier"] = bound.CostTier
	opts.Metadata["gateway.canonical_vendor"] = bound.Owner
	opts.Metadata["gateway.canonical_free"] = bound.Free
	return nil
}
func executeCanonicalGuarded(ctx context.Context, e ProviderExecutor, a *Auth, req cliproxyexecutor.Request, opts cliproxyexecutor.Options) (cliproxyexecutor.Response, error) {
	if err := validateCanonicalDispatch(a, req, &opts); err != nil {
		return cliproxyexecutor.Response{}, err
	}
	return e.Execute(ctx, a, req, opts)
}
func streamCanonicalGuarded(ctx context.Context, e ProviderExecutor, a *Auth, req cliproxyexecutor.Request, opts cliproxyexecutor.Options) (*cliproxyexecutor.StreamResult, error) {
	if err := validateCanonicalDispatch(a, req, &opts); err != nil {
		return nil, err
	}
	return e.ExecuteStream(ctx, a, req, opts)
}
func countCanonicalGuarded(ctx context.Context, e ProviderExecutor, a *Auth, req cliproxyexecutor.Request, opts cliproxyexecutor.Options) (cliproxyexecutor.Response, error) {
	if err := validateCanonicalDispatch(a, req, &opts); err != nil {
		return cliproxyexecutor.Response{}, err
	}
	return e.CountTokens(ctx, a, req, opts)
}

func (m *Manager) CanonicalRoutingEnabled() bool {
	cfg := m.runtimeConfigSnapshot()
	return cfg != nil && cfg.Models.CanonicalOnly
}
