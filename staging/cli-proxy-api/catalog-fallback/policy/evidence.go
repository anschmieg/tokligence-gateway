package catalogfallback

import (
	"encoding/json"
	"sort"
	"strings"
)

// Confidence is a policy weight, not a calibrated probability of model quality.
// Known incompatible settings are never made comparable by a low weight.
type evidencePoint struct {
	Benchmark
	value float64
	key   string
}

func evidencePoints(m Model, task Task) map[string][]evidencePoint {
	out := map[string][]evidencePoint{}
	seen := map[string]float64{}
	bad := map[string]bool{}
	for _, b := range m.Benchmarks {
		_, v, ok := benchmarkValue(b, task)
		if !ok {
			continue
		}
		exact, _ := json.Marshal([]string{strings.ToLower(b.Name), b.Metric, b.Version, b.Harness, b.Variant, b.Dataset})
		key := string(exact)
		if previous, exists := seen[key]; exists && previous != v {
			bad[key] = true
		}
		seen[key] = v
	}
	for _, b := range m.Benchmarks {
		_, v, ok := benchmarkValue(b, task)
		if !ok {
			continue
		}
		exact, _ := json.Marshal([]string{strings.ToLower(b.Name), b.Metric, b.Version, b.Harness, b.Variant, b.Dataset})
		key := string(exact)
		if bad[key] {
			continue
		}
		// Independent evidence counts benchmark tasks, not repeated reports/variants.
		name := strings.NewReplacer("-", "", "_", "", " ", "").Replace(strings.ToLower(b.Name)) + "\x00" + strings.ToLower(b.Metric)
		duplicate := false
		for _, p := range out[name] {
			if p.key == key {
				duplicate = true
				break
			}
		}
		if !duplicate {
			out[name] = append(out[name], evidencePoint{b, v, key})
		}
	}
	return out
}
func pairConfidence(a, b Benchmark) (float64, bool) {
	weight := 1.0
	for _, field := range []struct {
		a, b    string
		missing float64
	}{
		{a.Version, b.Version, .8}, {a.Harness, b.Harness, .7}, {a.Variant, b.Variant, .75}, {a.Dataset, b.Dataset, .9},
	} {
		if field.a != "" && field.b != "" {
			if field.a != field.b {
				return 0, false
			}
		} else {
			weight *= field.missing
		}
	}
	return weight, true
}
func compare(s *Snapshot, baseID, candidateID string, task Task) Comparison {
	out := Comparison{Band: "unknown", RiskLoss: unknownLossPrior}
	base, baseOK := s.model(baseID)
	other, otherOK := s.model(candidateID)
	if !baseOK || !otherOK {
		return out
	}
	source, target := evidencePoints(base, task), evidencePoints(other, task)
	out.ReferenceCount = len(source)
	totalWeight := 0.0
	strict := 0
	keys := make([]string, 0, len(source))
	for key := range source {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		as := source[key]
		bestWeight, loss := 0.0, 0.0
		bestStrict := false
		for _, a := range as {
			for _, b := range target[key] {
				w, ok := pairConfidence(a.Benchmark, b.Benchmark)
				if !ok {
					continue
				}
				d := a.value - b.value
				// Prefer best-established conditions; worst loss wins equal-confidence
				// conflicting variants. This is not best-score cherry-picking.
				if w > bestWeight || (w == bestWeight && d > loss) {
					bestWeight, loss = w, d
					bestStrict = a.Version != "" && b.Version != "" && a.Harness != "" && b.Harness != "" && a.Variant != "" && b.Variant != "" && a.Dataset == b.Dataset
				}
			}
		}
		if bestWeight == 0 {
			continue
		}
		out.Matched++
		totalWeight += bestWeight
		out.MeanLoss += bestWeight * loss
		if loss > out.WorstLoss {
			out.WorstLoss = loss
		}
		if bestStrict {
			strict++
		}
	}
	if out.Matched == 0 {
		return out
	}
	out.MeanLoss /= totalWeight
	out.Coverage = float64(out.Matched) / float64(out.ReferenceCount)
	// Saturating independent task support; duplicate records/credentials do not
	// increase confidence. Missing settings and missing coverage reduce weight.
	out.Confidence = (totalWeight / float64(out.Matched)) * out.Coverage * float64(out.Matched) / float64(out.Matched+1)
	out.RiskLoss = out.Confidence*out.MeanLoss + (1-out.Confidence)*unknownLossPrior
	out.Band = "partial"
	if strict >= 2 && strict == out.ReferenceCount {
		out.Band = "comparable"
	}
	return out
}

const unknownLossPrior = .25 // explicit conservative uncertainty policy, not a measured error rate
