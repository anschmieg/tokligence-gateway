package catalogfallback

// HasTaskEvidence qualifies curation, not authorization or a universal quality
// claim. It uses the same canonical identity, task taxonomy and validated score
// rules as fallback ranking. An unbenchmarked model remains in the full catalog.
func (s *Snapshot) HasTaskEvidence(provider, source string, task Task) bool {
	id, ok := s.Resolve(provider, source)
	if !ok {
		return false
	}
	m, ok := s.model(id)
	if !ok || (m.Type != "" && m.Type != "chat") {
		return false
	}
	for _, points := range evidencePoints(m, task) {
		for _, p := range points {
			if p.value > 0 {
				return true
			}
		}
	}
	return false
}
