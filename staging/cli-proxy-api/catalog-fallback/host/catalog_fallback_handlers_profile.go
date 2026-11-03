package handlers

import (
	"context"
	"errors"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/router-for-me/CLIProxyAPI/v8/internal/catalogfallback"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/interfaces"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/registry"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/thinking"
)

type profileRoute struct {
	Model    string
	Auth     string
	Priority int
	Binding  registry.CanonicalDispatchBinding
	Info     *registry.ModelInfo
}

type profileView struct {
	Profile  registry.ModelProfile
	Policy   registry.CanonicalRoutingConfig
	Evidence *catalogfallback.Snapshot
	Fresh    bool
}

func (h *BaseAPIHandler) newProfileView(name string) (profileView, bool) {
	policy := h.AuthManager.CanonicalRoutingPolicy()
	profile, ok := policy.Profile(name)
	if !ok {
		return profileView{}, false
	}
	age := time.Duration(policy.EvidenceMaxAgeHours) * time.Hour
	if age <= 0 {
		age = 7 * 24 * time.Hour
	}
	snapshot, fresh := catalogfallback.DefaultStore.AdvisorySnapshot(policy.EvidenceCatalog, time.Now(), age)
	return profileView{profile, policy, snapshot, fresh}, true
}
func (h *BaseAPIHandler) profileRouteSet(view profileView, r canonicalRequirements, preferred ...string) []profileRoute {
	now := time.Now()
	profile := view.Profile
	snapshot := view.Evidence
	routes := []profileRoute{}
	for _, model := range registry.GetGlobalRegistry().GetAvailableModelInfos() {
		if model.CanonicalPolicy != "canonical" || model.CanonicalID != model.ID {
			continue
		}
		selector := model.ID + ":free"
		for auth, info := range registry.GetGlobalRegistry().CanonicalRouteInfos(selector) {
			if !h.AuthManager.CanonicalFallbackAvailable(auth, selector, now) || !canonicalCompatible(info, r) {
				continue
			}
			isPreferred := len(preferred) > 0 && preferred[0] == model.ID
			if !isPreferred && !snapshot.HasTaskEvidence(info.OwnedBy, canonicalEvidenceSource(info), profile.Task) {
				continue
			}
			routes = append(routes, profileRoute{model.ID, auth, h.AuthManager.CanonicalPriority(auth), registry.NewCanonicalDispatchBinding(auth, selector, info), info})
		}
	}
	return routes
}

// ProfileModels is a view over the same currently eligible route/evidence set as
// execution. It neither registers virtual credentials nor authorizes paid usage.
func (h *BaseAPIHandler) ProfileModels(name string) (map[string]any, int) {
	if h.AuthManager == nil || !h.AuthManager.CanonicalRoutingEnabled() || h.AuthManager.HomeEnabled() {
		return map[string]any{"error": "model profiles unavailable"}, 503
	}
	req, _ := canonicalRequestRequirements([]byte(`{}`))
	view, ok := h.newProfileView(name)
	if !ok {
		return map[string]any{"error": "unknown model profile"}, 404
	}
	profile := view.Profile
	routes := h.profileRouteSet(view, req)
	priorities := map[string]int{}
	exists := map[string]bool{}
	for _, r := range routes {
		if !exists[r.Model] || r.Priority > priorities[r.Model] {
			priorities[r.Model] = r.Priority
		}
		exists[r.Model] = true
	}
	models := []string{}
	for id := range exists {
		models = append(models, id)
	}
	sort.Slice(models, func(i, j int) bool {
		if priorities[models[i]] != priorities[models[j]] {
			return priorities[models[i]] > priorities[models[j]]
		}
		return models[i] < models[j]
	})
	if len(models) > profile.MaxModels {
		models = models[:profile.MaxModels]
	}
	data := []map[string]any{}
	for _, id := range models {
		row := registry.CatalogMetadata(id)
		if row == nil {
			continue
		} // model may be withdrawn between curation and serialization
		row["id"] = id
		row["object"] = "model"
		row["profile"] = name
		row["model_role"] = "hint"
		row["cost_policy"] = "free-only"
		row["task"] = string(profile.Task)
		row["selection_reason"] = "verified task evidence and eligible no-additional-charge route"
		row["credential_priority"] = priorities[id]
		row["routing_policy"] = "preferred-then-similar-free-only"
		delete(row, "free_only_id") // syntax is contractual, not another availability proof
		data = append(data, row)
	}
	return map[string]any{"object": "list", "data": data, "profile": name, "task": string(profile.Task), "cost_policy": "free-only", "policy_version": "task-profile-v1", "full_catalog": "/v1/models", "model_role": "hint", "evidence_stale": !view.Fresh}, 200
}
func (h *BaseAPIHandler) profileCanonicalPlan(ctx context.Context, name, model string, raw []byte, opts modelExecutionOptions) (canonicalPlan, bool, *interfaces.ErrorMessage) {
	fail := func(status int, message string) (canonicalPlan, bool, *interfaces.ErrorMessage) {
		return canonicalPlan{}, true, &interfaces.ErrorMessage{StatusCode: status, Error: errors.New(message)}
	}
	if h.AuthManager == nil || !h.AuthManager.CanonicalRoutingEnabled() || h.AuthManager.HomeEnabled() {
		return fail(503, "model profiles unavailable")
	}
	r, err := canonicalRequestRequirements(raw)
	if err != nil {
		return fail(400, "invalid or ambiguous profile request")
	}
	if r.UnverifiedCostFeatures {
		return fail(400, "profile cannot admit unverified hosted-tool, premium-tier or upstream-routing charges")
	}
	// Thinking suffix is applied natively too; preserve the exact requested mode.
	parsed := thinking.ParseSuffix(model)
	hint := strings.TrimSuffix(parsed.ModelName, ":free")
	if strings.HasSuffix(parsed.ModelName, ":paid") {
		return fail(400, "paid selector conflicts with this no-additional-charge profile")
	}
	canonicalSuffixRequirements(model, &r)
	view, ok := h.newProfileView(name)
	if !ok {
		return fail(404, "unknown model profile")
	}
	profile := view.Profile
	policy := view.Policy
	originalOpaque := r.OpaqueState
	r.OpaqueState = false // only used to admit the exact hint below; never discarded from payload
	routes := h.profileRouteSet(view, r, hint)
	if len(routes) == 0 {
		return fail(503, "no currently eligible no-charge models with verified profile evidence")
	}
	if r.Tools {
		r.Task = catalogfallback.Agent
	} else {
		r.Task = profile.Task
	}
	p := canonicalPlan{Requested: model, Base: hint, Policy: "free-only", Profile: name, Limit: policy.AttemptLimit(), Requirements: r}
	if parsed.HasSuffix {
		p.Suffix = strings.TrimPrefix(model, parsed.ModelName)
	}
	byModel := map[string][]profileRoute{}
	rankRoutes := []catalogfallback.Route{}
	for _, route := range routes {
		if originalOpaque && route.Model != hint {
			continue
		}
		byModel[route.Model] = append(byModel[route.Model], route)
		rankRoutes = append(rankRoutes, catalogfallback.Route{ID: route.Auth, ModelID: route.Model, Provider: route.Info.OwnedBy, SourceID: canonicalEvidenceSource(route.Info), Free: true, Available: true, Capabilities: registry.CanonicalFallbackCapabilities(route.Info), FailureDomain: route.Info.OwnedBy})
	}
	// Reference identity is independent of eligibility. A temporarily unavailable
	// or paid-only preferred route still anchors similarity; never re-anchor to
	// the last failed alternate or lose the reference because its quota ran out.
	for _, selector := range []string{hint + ":free", hint + ":paid", hint} {
		for auth, info := range registry.GetGlobalRegistry().CanonicalRouteInfos(selector) {
			rankRoutes = append(rankRoutes, catalogfallback.Route{ID: auth, ModelID: hint, Provider: info.OwnedBy, SourceID: canonicalEvidenceSource(info), Free: info.CanonicalFree, Available: false})
		}
	}
	var rankSnapshot *catalogfallback.Snapshot
	if view.Fresh {
		rankSnapshot = view.Evidence
	}
	referenceID, _ := rankSnapshot.ResolveReference(hint)
	plan := catalogfallback.Rank(hint, r, rankRoutes, rankSnapshot, catalogfallback.Policy{AllowUnknown: true, MaxModels: policy.FallbackLimit(), ReferenceID: referenceID})
	if plan.Refused != "" {
		return fail(409, "profile model identity is ambiguous; use an exact provider override")
	}
	comparisons := map[string]catalogfallback.Comparison{}
	for _, candidate := range plan.Candidates {
		comparisons[candidate.ModelID] = candidate.Comparison
	}
	order := []string{}
	if _, ok := byModel[hint]; ok {
		order = append(order, hint)
	}
	for _, c := range plan.Candidates {
		if _, ok := byModel[c.ModelID]; ok {
			order = append(order, c.ModelID)
		}
	}
	if len(order) == 0 {
		return fail(409, "opaque or incompatible conversation requires an exact eligible model; use the full endpoint")
	}
	// Model order is policy-owned: preferred first, then similarity to that
	// original preference. Native priority/weights operate WITHIN each model,
	// never promote a different model or cycle a fallback pool round-robin.
	for _, id := range order {
		allowed := map[string]bool{}
		bindings := map[string]registry.CanonicalDispatchBinding{}
		for _, route := range byModel[id] {
			allowed[route.Auth] = true
			bindings[route.Auth] = route.Binding
		}
		if len(allowed) > 0 {
			var evidence *canonicalComparison
			if comparison, ok := comparisons[id]; ok {
				evidence = &comparison
			}
			p.Stages = append(p.Stages, canonicalStage{Model: id + ":free", Alternative: id != hint, Allowed: allowed, PlannedBindings: bindings, Evidence: evidence})
		}
	}
	p.Requirements.OpaqueState = originalOpaque
	return p, true, nil
}

func canonicalSelectionHeaders(headers http.Header, p canonicalPlan, stage canonicalStage) {
	reason := "preferred-model"
	if stage.Alternative {
		reason = "similarity-ranked-fallback"
	}
	headers.Set("X-Gateway-Selection-Reason", reason)
	if stage.Evidence != nil {
		headers.Set("X-Gateway-Similarity-Band", stage.Evidence.Band)
		headers.Set("X-Gateway-Similarity-Confidence", strconv.FormatFloat(stage.Evidence.Confidence, 'f', 3, 64))
	}
}
