package registry

import "sync/atomic"

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

// CanonicalDispatchBinding captures the admitted target. It is never an alias.
type CanonicalDispatchBinding struct {
	AuthID, Route, Source, PairSource, Owner, PluginSource, CostTier string
	Free                                                             bool
}

func NewCanonicalDispatchBinding(auth, route string, info *ModelInfo) CanonicalDispatchBinding {
	source := info.CanonicalSourceID
	if source == "" {
		source = info.ID
	}
	pair := info.MetadataModelID
	if pair == "" {
		pair = source
	}
	return CanonicalDispatchBinding{AuthID: auth, Route: route, Source: source, PairSource: pair, Owner: info.OwnedBy, PluginSource: info.PluginSourceModelID, CostTier: info.PluginCostTier, Free: info.CanonicalFree}
}

// One shared permit survives native metadata clones. A hidden retry cannot
// claim another physical dispatch, even inside a streaming model pool.
type CanonicalDispatchPermit struct{ claimed atomic.Bool }

func (p *CanonicalDispatchPermit) Claim() bool {
	return p != nil && p.claimed.CompareAndSwap(false, true)
}
