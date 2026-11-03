package catalogfallback

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"sort"
	"time"
)

type Task string

const (
	General     Task = "general"
	Coding      Task = "coding"
	Agent       Task = "agent"
	Reasoning   Task = "reasoning"
	Structured  Task = "structured"
	LongContext Task = "long-context"
)

type Capabilities struct {
	Context, InputLimit, Output                                  int
	Tools, ToolChoice, Parallel, JSON, StructuredJSON, Reasoning bool
	ReasoningLevels                                              []string
	BudgetMin, BudgetMax                                         int
	AutoReasoning, DisableReasoning                              bool
	InputModalities, OutputModalities                            []string
	Chat                                                         bool
}
type Requirements struct {
	Bytes, Output                                                int
	Tools, ToolChoice, Parallel, JSON, StructuredJSON, Reasoning bool
	ReasoningEffort                                              string
	ReasoningBudget                                              *int
	DisableReasoning                                             bool
	Continuity, OpaqueState                                      bool
	UnverifiedCostFeatures                                       bool
	Modalities, Outputs                                          map[string]bool
	Task                                                         Task
}
type Route struct {
	ID, ModelID, Provider, SourceID, FailureDomain string
	Capabilities                                   Capabilities
	Free, Available                                bool          // exclusively supplied by native route admission
	LatencyP95                                     time.Duration // passive exact-route measurement, zero = unknown
}
type Policy struct {
	MaxModels         int
	AllowUnknown      bool
	RequireComparable bool
	Deadline          time.Duration
	MaxLoss           *float64
	ReferenceID       string // server-resolved exact reference, never route admission
}
type Comparison struct {
	Matched, ReferenceCount       int
	Coverage, MeanLoss, WorstLoss float64
	Confidence, RiskLoss          float64
	Band                          string
}
type Candidate struct {
	ModelID, EvidenceID, Family string
	Comparison                  Comparison
	RouteIDs                    []string
	FailureDomains              []string
	LatencyP95                  time.Duration
	Continuity                  bool
	Reason                      string
}
type Plan struct {
	Candidates []Candidate
	Refused    string
}

func Compatible(c Capabilities, r Requirements) bool {
	if r.OpaqueState || !c.Chat || c.Context <= 0 || c.Context < r.Bytes || (c.InputLimit > 0 && c.InputLimit < r.Bytes) || r.Output > c.Context-r.Bytes {
		return false
	}
	if r.Output > 0 && (c.Output <= 0 || c.Output < r.Output) {
		return false
	}
	for m := range r.Modalities {
		if m != "text" || !has(c.InputModalities, m) {
			return false
		}
	} // opaque media budgets not established
	for m := range r.Outputs {
		if !has(c.OutputModalities, m) {
			return false
		}
	}
	if r.Tools && !c.Tools || r.ToolChoice && !c.ToolChoice || r.Parallel && !c.Parallel || r.JSON && !c.JSON || r.StructuredJSON && !c.StructuredJSON {
		return false
	}
	if r.Reasoning && !c.Reasoning || r.DisableReasoning && !c.DisableReasoning {
		return false
	}
	if r.ReasoningEffort != "" && !has(c.ReasoningLevels, r.ReasoningEffort) {
		return false
	}
	if r.ReasoningBudget != nil {
		n := *r.ReasoningBudget
		if n == -1 {
			if !c.AutoReasoning {
				return false
			}
		} else if n == 0 {
			if !c.DisableReasoning {
				return false
			}
		} else if c.BudgetMax <= 0 || n < c.BudgetMin || n > c.BudgetMax {
			return false
		}
	}
	return true
}
func has(values []string, s string) bool {
	for _, v := range values {
		if v == s {
			return true
		}
	}
	return false
}
func CapabilitiesHash(c Capabilities) string {
	c.ReasoningLevels = append([]string(nil), c.ReasoningLevels...)
	sort.Strings(c.ReasoningLevels)
	c.InputModalities = append([]string(nil), c.InputModalities...)
	sort.Strings(c.InputModalities)
	c.OutputModalities = append([]string(nil), c.OutputModalities...)
	sort.Strings(c.OutputModalities)
	b, _ := json.Marshal(c)
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}
func Rank(requested string, r Requirements, routes []Route, s *Snapshot, p Policy) Plan {
	if r.UnverifiedCostFeatures {
		return Plan{Refused: "request contains unverified metered features"}
	}
	if r.OpaqueState {
		return Plan{Refused: "opaque conversation state is not transferable"}
	}
	if p.MaxModels <= 0 {
		p.MaxModels = 3
	}
	if p.MaxModels > 6 {
		p.MaxModels = 6
	}
	if p.MaxLoss != nil && (*p.MaxLoss < 0 || *p.MaxLoss > 1) {
		return Plan{Refused: "invalid quality-loss bound"}
	}
	if r.Task == "" {
		r.Task = General
	}
	sourceID, sourceConflict := "", false
	for _, route := range routes {
		if route.ModelID != requested {
			continue
		}
		id, ok := s.Resolve(route.Provider, route.SourceID)
		if !ok {
			continue
		}
		if sourceID != "" && sourceID != id {
			sourceConflict = true
		}
		sourceID = id
	}
	if p.ReferenceID != "" {
		if _, ok := s.model(p.ReferenceID); !ok {
			return Plan{Refused: "unknown reference identity"}
		}
		if sourceID != "" && sourceID != p.ReferenceID {
			sourceConflict = true
		}
		sourceID = p.ReferenceID
	}
	if sourceConflict {
		return Plan{Refused: "requested canonical group has conflicting catalog identities"}
	}
	sourceFamily := s.Family(sourceID)
	byModel := map[string][]Route{}
	for _, route := range routes {
		if route.ModelID == requested || !route.Free || !route.Available || !Compatible(route.Capabilities, r) {
			continue
		}
		if p.Deadline > 0 && route.LatencyP95 > p.Deadline {
			continue
		}
		byModel[route.ModelID] = append(byModel[route.ModelID], route)
	}
	candidates := []Candidate{}
	for model, group := range byModel {
		c := Candidate{ModelID: model, Comparison: Comparison{Band: "unknown", RiskLoss: unknownLossPrior}, Reason: "capability-compatible; quality evidence unknown"}
		identities := map[string]bool{}
		domains := map[string]bool{}
		knownRoutes := []Route{}
		allLatency := true
		for _, route := range group {
			if route.FailureDomain != "" {
				domains[route.FailureDomain] = true
			}
			id, ok := s.Resolve(route.Provider, route.SourceID)
			if ok {
				identities[id] = true
				knownRoutes = append(knownRoutes, route)
			}
			if route.LatencyP95 == 0 {
				allLatency = false
			} else if route.LatencyP95 > c.LatencyP95 {
				c.LatencyP95 = route.LatencyP95
			}
		}
		if len(identities) > 1 {
			continue
		} // A mislabeled group must not borrow one member's benchmarks.
		// Do not erase a known model's evidence when a newly added provider has
		// no exact identity proof. That route stays outside this ranked attempt
		// set; it cannot borrow the proof either. Entirely unknown models retain
		// the separately explicit unknown-evidence policy.
		if len(knownRoutes) > 0 {
			group = knownRoutes
		}
		c.FailureDomains = nil
		domains = map[string]bool{}
		allLatency = true
		c.LatencyP95 = 0
		for _, route := range group {
			c.RouteIDs = append(c.RouteIDs, route.ID)
			if route.FailureDomain != "" {
				domains[route.FailureDomain] = true
			}
			if route.LatencyP95 == 0 {
				allLatency = false
			} else if route.LatencyP95 > c.LatencyP95 {
				c.LatencyP95 = route.LatencyP95
			}
		}
		if len(identities) == 1 {
			for id := range identities {
				c.EvidenceID = id
			}
			if m, ok := s.model(c.EvidenceID); ok && m.Type != "" && m.Type != "chat" {
				continue
			}
			c.Family = s.Family(c.EvidenceID)
			c.Continuity = r.Continuity && sourceFamily != "" && sourceFamily == c.Family
			c.Comparison = compare(s, sourceID, c.EvidenceID, r.Task)
			if c.Comparison.Matched > 0 {
				c.Reason = "confidence-weighted published benchmark evidence; missing settings reduce confidence"
			}
		}
		if !allLatency {
			c.LatencyP95 = 0
		}
		if p.RequireComparable && c.Comparison.Band != "comparable" {
			continue
		}
		if !p.AllowUnknown && c.Comparison.Band == "unknown" {
			continue
		}
		if p.MaxLoss != nil && (c.Comparison.Band != "comparable" || c.Comparison.WorstLoss > *p.MaxLoss) {
			continue
		}
		for d := range domains {
			c.FailureDomains = append(c.FailureDomains, d)
		}
		sort.Strings(c.RouteIDs)
		sort.Strings(c.FailureDomains)
		candidates = append(candidates, c)
	}
	sort.Slice(candidates, func(i, j int) bool {
		a, b := candidates[i], candidates[j]
		if a.Comparison.RiskLoss != b.Comparison.RiskLoss {
			return a.Comparison.RiskLoss < b.Comparison.RiskLoss
		}
		if a.Comparison.Confidence != b.Comparison.Confidence {
			return a.Comparison.Confidence > b.Comparison.Confidence
		}
		if a.Continuity != b.Continuity {
			return a.Continuity
		} // soft tie-break, never an absolute family class
		if (a.LatencyP95 > 0) != (b.LatencyP95 > 0) {
			return a.LatencyP95 > 0
		}
		if a.LatencyP95 > 0 && b.LatencyP95 > 0 && a.LatencyP95 != b.LatencyP95 {
			return a.LatencyP95 < b.LatencyP95
		}
		return a.ModelID < b.ModelID
	})
	// Within the same evidence/quality band prefer another known failure domain.
	// Never manufacture upstream independence for a route with an unknown domain.
	selected := []Candidate{}
	used := map[string]bool{}
	for len(candidates) > 0 && len(selected) < p.MaxModels {
		pick := 0
		first := candidates[0]
		for i, c := range candidates {
			if c.Comparison.RiskLoss != first.Comparison.RiskLoss || c.Comparison.Confidence != first.Comparison.Confidence {
				break
			}
			fresh := false
			for _, d := range c.FailureDomains {
				if !used[d] {
					fresh = true
				}
			}
			if fresh {
				pick = i
				break
			}
		}
		c := candidates[pick]
		selected = append(selected, c)
		for _, d := range c.FailureDomains {
			used[d] = true
		}
		candidates = append(candidates[:pick], candidates[pick+1:]...)
	}
	return Plan{Candidates: selected}
}
