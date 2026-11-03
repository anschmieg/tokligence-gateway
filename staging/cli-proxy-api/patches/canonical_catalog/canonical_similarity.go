package handlers

import (
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/router-for-me/CLIProxyAPI/v8/internal/registry"
	log "github.com/sirupsen/logrus"
)

// Similarity uses observable metadata and model-name features, never provider
// identity, traffic, account count, prompts sent to a classifier, or benchmarks
// we do not have. Scores express proximity, not quality or weight equivalence.
var canonicalNameParts = regexp.MustCompile(`[a-z]+|[0-9]+(?:\.[0-9]+)*`)
var canonicalDate = regexp.MustCompile(`(?:^|[-_])(?:19|20)[0-9]{2}[-_][0-9]{2}[-_][0-9]{2}(?:$|[-_])`)
var canonicalSize = regexp.MustCompile(`(?:^|[-_:])([0-9]+(?:\.[0-9]+)?)b(?:$|[-_:])`)

type canonicalModelFeatures struct {
	Family           string
	Version          []int
	Size             float64
	Tokens           map[string]bool
	Specialty, Scale string
}

func canonicalFeatures(id string) canonicalModelFeatures {
	id = strings.ToLower(strings.TrimSuffix(id, ":free"))
	// Canonical names can retain a publisher namespace. It is not a model family.
	if i := strings.LastIndex(id, "/"); i >= 0 {
		id = id[i+1:]
	}
	parts := canonicalNameParts.FindAllString(canonicalDate.ReplaceAllString(id, "-"), -1)
	f := canonicalModelFeatures{Tokens: map[string]bool{}}
	if len(parts) == 0 {
		return f
	}
	f.Family = parts[0]
	if strings.HasPrefix(id, "gpt-oss") {
		f.Family = "gpt-oss"
	}
	if strings.HasPrefix(id, "command-r") {
		f.Family = "command-r"
	}
	for i, part := range parts {
		if part == "free" || part == "preview" || part == "latest" || part == "instruct" || part == "chat" {
			continue
		}
		if _, err := strconv.ParseFloat(part, 64); err != nil {
			f.Tokens[part] = true
			continue
		}
		// Parameter counts, context sizes and dates are not generation versions.
		if i+1 < len(parts) && (parts[i+1] == "b" || parts[i+1] == "k" || parts[i+1] == "m") {
			continue
		}
		if len(f.Version) > 0 {
			continue
		}
		v := strings.Split(part, ".")
		major, err := strconv.Atoi(v[0])
		if err != nil || major > 99 {
			continue
		}
		f.Version = []int{major, 0}
		if len(v) > 1 {
			f.Version[1], _ = strconv.Atoi(v[1])
		} else if i+1 < len(parts) {
			// Both glm-5.3 and glm-5-3 spellings retain numeric proximity.
			if minor, err := strconv.Atoi(parts[i+1]); err == nil && minor < 100 && !(i+2 < len(parts) && (parts[i+2] == "b" || parts[i+2] == "k" || parts[i+2] == "m")) {
				f.Version[1] = minor
			}
		}
	}
	if match := canonicalSize.FindStringSubmatch(id); len(match) > 0 {
		f.Size, _ = strconv.ParseFloat(match[1], 64)
	}
	for _, tag := range []string{"coder", "code", "codex", "codestral", "devstral"} {
		if f.Tokens[tag] {
			f.Specialty = "code"
		}
	}
	if f.Tokens["math"] {
		f.Specialty = "math"
	}
	for _, tag := range []string{"flash", "lite", "mini", "nano", "small", "haiku", "lightning", "instant", "fast"} {
		if f.Tokens[tag] {
			f.Scale = "fast"
		}
	}
	for _, tag := range []string{"pro", "opus", "ultra", "large", "max"} {
		if f.Tokens[tag] {
			f.Scale = "large"
		}
	}
	return f
}

func canonicalFamily(id string) string {
	family := canonicalFeatures(id).Family
	if family == "" {
		return "default"
	}
	return family
}

// A declared embedding/reranking/audio generation endpoint is not a chat
// substitute merely because some metadata calls its output "text".
func canonicalConversationCandidate(m *registry.ModelInfo) bool {
	f := canonicalFeatures(m.CanonicalID)
	for _, tag := range []string{"embedding", "embed", "rerank", "reranker", "tts", "asr", "whisper", "transcription"} {
		if f.Tokens[tag] {
			return false
		}
	}
	if len(m.SupportedGenerationMethods) == 0 {
		return true
	}
	for _, method := range m.SupportedGenerationMethods {
		normalized := strings.NewReplacer("-", "", "_", "", "/", "", ".", "").Replace(strings.ToLower(method))
		switch normalized {
		case "generatecontent", "streamgeneratecontent", "chat", "chatcompletion", "chatcompletions", "completion", "completions", "textgeneration":
			return true
		}
	}
	return false
}

func canonicalContext(m *registry.ModelInfo) int {
	if m == nil {
		return 0
	}
	if m.ContextLength > 0 {
		return m.ContextLength
	}
	return m.InputTokenLimit
}
func canonicalOutput(m *registry.ModelInfo) int {
	if m == nil {
		return 0
	}
	if m.MaxCompletionTokens > 0 {
		return m.MaxCompletionTokens
	}
	return m.OutputTokenLimit
}
func canonicalSet(values []string) map[string]bool {
	out := map[string]bool{}
	for _, s := range values {
		out[strings.ToLower(s)] = true
	}
	return out
}
func canonicalOverlap(a, b map[string]bool, weight int) int {
	if len(a) == 0 || len(b) == 0 {
		return 0
	}
	union, shared := len(a), 0
	for k := range b {
		if a[k] {
			shared++
		} else {
			union++
		}
	}
	return weight * shared / union
}
func canonicalMagnitude(a, b float64, weight int) int {
	if a <= 0 || b <= 0 {
		return 0
	}
	// Symmetric logarithmic distance: half/double are equally close; unlimited
	// context or parameter count cannot dominate all other dimensions.
	return int(float64(weight) / (1 + math.Abs(math.Log2(a/b))))
}
func canonicalReasoning(m *registry.ModelInfo) bool {
	return m != nil && (m.Thinking != nil || containsCanonical(m.SupportedParameters, "reasoning") || containsCanonical(m.SupportedParameters, "reasoning_effort"))
}

type canonicalSimilarity struct {
	ID         string         `json:"model"`
	Score      int            `json:"score"`
	Continuity bool           `json:"family_continuity"`
	Components map[string]int `json:"components"`
}

func canonicalScore(baseID string, base, candidate *registry.ModelInfo, r canonicalRequirements, configured map[string]int) canonicalSimilarity {
	a, b := canonicalFeatures(baseID), canonicalFeatures(candidate.CanonicalID)
	same := a.Family != "" && a.Family == b.Family
	out := canonicalSimilarity{ID: candidate.CanonicalID, Continuity: r.Continuity && same, Components: map[string]int{}}
	c := out.Components
	if same {
		c["family"] = 180
	}
	if same && len(a.Version) > 0 && len(b.Version) > 0 {
		// Major versions dominate minor versions; compare numerically, never by ID.
		d := 8*math.Abs(float64(a.Version[0]-b.Version[0])) + math.Abs(float64(a.Version[1]-b.Version[1]))
		c["generation"] = int(120 / (1 + d/4))
	}
	c["name_features"] = canonicalOverlap(a.Tokens, b.Tokens, 100)
	if a.Specialty != "" {
		if a.Specialty == b.Specialty {
			c["specialization"] = 220
		} else {
			c["specialization"] = -200
		}
	}
	if a.Scale != "" && b.Scale != "" {
		if a.Scale == b.Scale {
			c["scale_profile"] = 70
		} else {
			c["scale_profile"] = -35
		}
	}
	c["parameter_scale"] = canonicalMagnitude(a.Size, b.Size, 60)
	if base != nil {
		c["context"] = canonicalMagnitude(float64(canonicalContext(base)), float64(canonicalContext(candidate)), 100)
		c["output"] = canonicalMagnitude(float64(canonicalOutput(base)), float64(canonicalOutput(candidate)), 80)
		c["parameters"] = canonicalOverlap(canonicalSet(base.SupportedParameters), canonicalSet(candidate.SupportedParameters), 100)
		c["input_modalities"] = canonicalOverlap(canonicalSet(base.SupportedInputModalities), canonicalSet(candidate.SupportedInputModalities), 40)
		c["output_modalities"] = canonicalOverlap(canonicalSet(base.SupportedOutputModalities), canonicalSet(candidate.SupportedOutputModalities), 40)
		if canonicalReasoning(base) == canonicalReasoning(candidate) {
			c["reasoning_profile"] = 60
		}
	}
	if rank, ok := configured[candidate.CanonicalID]; ok {
		c["operator_preference"] = 200 / (rank + 1)
	}
	for _, v := range c {
		out.Score += v
	}
	return out
}

func canonicalFallbackRanking(base string, r canonicalRequirements, p registry.CanonicalRoutingConfig) []canonicalSimilarity {
	// Opaque state cannot safely change models, even within a named family.
	if r.OpaqueState {
		return nil
	}
	reg := registry.GetGlobalRegistry()
	reference := reg.GetModelInfo(base, "")
	configured := map[string]int{}
	list := p.FreeFallbacks[canonicalFamily(base)]
	if len(list) == 0 {
		list = p.FreeFallbacks["default"]
	}
	for i, id := range list {
		if _, ok := configured[id]; !ok {
			configured[id] = i
		}
	}
	out := []canonicalSimilarity{}
	for _, info := range reg.GetAvailableModelInfos() {
		id := info.ID
		if id == base || info.CanonicalID != id || info.CanonicalPolicy != "canonical" || strings.Contains(id, "search") || strings.Contains(id, "auto/") || strings.Contains(id, "router/") {
			continue
		}
		var best canonicalSimilarity
		eligible := false
		// Score actual eligible route metadata, not an impossible union of features
		// from different providers. Use the least similar eligible route because
		// native selection may choose any of them; duplicate credentials add no score.
		for authID, route := range reg.CanonicalRouteInfos(id + ":free") {
			if !canonicalCompatible(route, r) || !canonicalAlternativeAvailable(authID, route) {
				continue
			}
			score := canonicalScore(base, reference, route, r, configured)
			if !eligible || score.Score < best.Score {
				best = score
				eligible = true
			}
		}
		if eligible {
			out = append(out, best)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Continuity != out[j].Continuity {
			return out[i].Continuity
		}
		if out[i].Score != out[j].Score {
			return out[i].Score > out[j].Score
		}
		return out[i].ID < out[j].ID // Stable tie only; no ID-based proxy for quality.
	})
	limit := p.FallbackLimit()
	if len(out) > limit {
		// A bounded agent-continuity shortlist retains a cross-family rescue rather
		// than spending every slot on closely related models sharing an outage.
		if r.Continuity && limit > 1 && out[limit-1].Continuity {
			for _, candidate := range out[limit:] {
				if !candidate.Continuity {
					out[limit-1] = candidate
					break
				}
			}
		}
		out = out[:limit]
	}
	return out
}
func canonicalAlternativeAvailable(auth string, info *registry.ModelInfo) bool {
	reg := registry.GetGlobalRegistry()
	// Native selection remains authoritative. Do not spend shortlist slots on
	// already recorded suspensions, and never clear/probe a cooldown here.
	for _, key := range []string{info.ID, info.CanonicalID, info.CanonicalSourceID, info.MetadataModelID} {
		if key != "" && (reg.IsModelSuspendedForClient(auth, key) || reg.IsModelQuotaExceededForClient(auth, key)) {
			return false
		}
	}
	return true
}

func canonicalRankedFallbacks(base string, r canonicalRequirements, p registry.CanonicalRoutingConfig) []string {
	ranked := canonicalFallbackRanking(base, r, p)
	ids := make([]string, 0, len(ranked))
	for _, v := range ranked {
		ids = append(ids, v.ID)
	}
	log.WithFields(log.Fields{"requested_model": base, "fallback_ranking": ranked, "agent_continuity": r.Continuity, "opaque_state": r.OpaqueState}).Debug("canonical compatible free alternatives ranked")
	return ids
}
