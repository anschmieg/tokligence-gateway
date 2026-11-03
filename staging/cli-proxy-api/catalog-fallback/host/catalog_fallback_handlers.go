package handlers

import (
	"context"
	"encoding/json"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/thinking"
	log "github.com/sirupsen/logrus"
	"time"

	"github.com/router-for-me/CLIProxyAPI/v8/internal/catalogfallback"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/modelidentity"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/registry"
)

type canonicalRequirements = catalogfallback.Requirements

func canonicalRequestRequirements(raw []byte) (canonicalRequirements, error) {
	return catalogfallback.RequirementsFromJSON(raw)
}
func canonicalCompatible(info *registry.ModelInfo, r canonicalRequirements) bool {
	return info != nil && info.CanonicalFree && catalogfallback.Compatible(registry.CanonicalFallbackCapabilities(info), r)
}

func (h *BaseAPIHandler) canonicalEvidenceStages(ctx context.Context, base string, r canonicalRequirements, p registry.CanonicalRoutingConfig) []canonicalStage {
	if p.EvidenceCatalog == "" || p.EvidenceCatalog == "disabled" {
		return nil
	}
	now := time.Now()
	reg := registry.GetGlobalRegistry()
	routes := []catalogfallback.Route{}
	for _, m := range reg.GetAvailableModelInfos() {
		if m.CanonicalPolicy != "canonical" || m.CanonicalID != m.ID {
			continue
		}
		selectors := []string{m.ID + ":free"}
		if m.ID == base {
			selectors = append(selectors, m.ID+":paid")
		}
		for _, selector := range selectors {
			for id, info := range reg.CanonicalRouteInfos(selector) {
				source := canonicalEvidenceSource(info)
				routes = append(routes, catalogfallback.Route{ID: id, ModelID: m.ID, Provider: info.OwnedBy, SourceID: source, FailureDomain: info.OwnedBy, Capabilities: registry.CanonicalFallbackCapabilities(info), Free: info.CanonicalFree, Available: h.AuthManager.CanonicalFallbackAvailable(id, selector, now)})
			}
		}
	}
	age := time.Duration(p.EvidenceMaxAgeHours) * time.Hour
	if age <= 0 {
		age = 7 * 24 * time.Hour
	}
	policy := catalogfallback.Policy{MaxModels: p.FallbackLimit(), AllowUnknown: !p.RequireComparableEvidence, RequireComparable: p.RequireComparableEvidence}
	if deadline, ok := ctx.Deadline(); ok {
		policy.Deadline = time.Until(deadline)
		if policy.Deadline <= 0 {
			return nil
		}
	}
	plan := catalogfallback.Rank(base, r, routes, catalogfallback.DefaultStore.SnapshotForSource(p.EvidenceCatalog, now, age), policy)
	summary := []map[string]any{}
	for _, c := range plan.Candidates {
		summary = append(summary, map[string]any{"model": c.ModelID, "catalog_model": c.EvidenceID, "band": c.Comparison.Band, "matched": c.Comparison.Matched, "coverage": c.Comparison.Coverage, "confidence": c.Comparison.Confidence, "risk_loss": c.Comparison.RiskLoss, "worst_loss": c.Comparison.WorstLoss, "reason": c.Reason})
	}
	details, _ := json.Marshal(map[string]any{"requested_model": base, "candidates": summary, "refused": plan.Refused})
	log.Debugf("catalog fallback decision %s", details)
	stages := []canonicalStage{}
	for _, candidate := range plan.Candidates {
		allowed := map[string]bool{}
		for _, id := range candidate.RouteIDs {
			allowed[id] = true
		}
		stages = append(stages, canonicalStage{Model: candidate.ModelID + ":free", Tier: 0, Alternative: true, Allowed: allowed})
	}
	return stages
}

func canonicalEvidenceSource(info *registry.ModelInfo) string {
	if info.PluginSourceModelID != "" {
		return modelidentity.TransportSource(info.PluginSourceModelID, info.OwnedBy)
	}
	// The final upstream source is authoritative; MetadataModelID can contain an
	// operator auth prefix used internally for availability/cooldown identity.
	if info.CanonicalSourceID != "" {
		return info.CanonicalSourceID
	}
	return info.MetadataModelID
}
func canonicalSuffixRequirements(model string, r *canonicalRequirements) {
	parsed := thinking.ParseSuffix(model)
	if !parsed.HasSuffix {
		return
	}
	r.ReasoningEffort = ""
	r.ReasoningBudget = nil
	r.DisableReasoning = false
	if n, ok := thinking.ParseNumericSuffix(parsed.RawSuffix); ok {
		r.ReasoningBudget = &n
		if n == 0 {
			r.DisableReasoning = true
		} else {
			r.Reasoning = true
		}
		return
	}
	if mode, ok := thinking.ParseSpecialSuffix(parsed.RawSuffix); ok {
		if mode == thinking.ModeNone {
			r.DisableReasoning = true
		} else {
			n := -1
			r.ReasoningBudget = &n
			r.Reasoning = true
		}
		return
	}
	if level, ok := thinking.ParseLevelSuffix(parsed.RawSuffix); ok {
		r.ReasoningEffort = string(level)
		r.Reasoning = true
		return
	}
	r.OpaqueState = true // No safe interpretation for cross-model substitution.
}
