package registry

// CanonicalRoutingConfig bounds deliberate policy failover, not SDK retries.
type CanonicalRoutingConfig struct {
	MaxAttempts       int                 `yaml:"max-attempts,omitempty" json:"max-attempts,omitempty"`
	MaxFallbackModels int                 `yaml:"max-fallback-models,omitempty" json:"max-fallback-models,omitempty"`
	FreeFallbacks     map[string][]string `yaml:"free-fallbacks,omitempty" json:"free-fallbacks,omitempty"`
}

func (p CanonicalRoutingConfig) AttemptLimit() int {
	if p.MaxAttempts < 1 {
		return 8
	}
	if p.MaxAttempts > 12 {
		return 12
	}
	return p.MaxAttempts
}
func (p CanonicalRoutingConfig) FallbackLimit() int {
	if p.MaxFallbackModels < 1 {
		return 3
	}
	if p.MaxFallbackModels > 6 {
		return 6
	}
	return p.MaxFallbackModels
}
