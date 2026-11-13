package openaicompat

// Publish the model's cost evidence separately from display names and aliases.
// showPaid changes visibility, never the model's economic classification.
func (a *adapter) modelCostTier(m upstreamModel) string {
	if m.pricingPresent && !m.verifiedZero {
		return "paid"
	}
	switch a.provider.Filter {
	case FilterFlagged, FilterZeroPrice:
		if m.free {
			return "free"
		}
		return "paid"
	case FilterVerifiedZero:
		if m.verifiedZero {
			return "free"
		}
	case FilterFlash:
		if flashModel.MatchString(m.ID) {
			return "free"
		}
	case FilterLLM7Free:
		if (m.Tier == "free" || m.Tier == "turbo") && m.UsagePolicyKnown && !m.UsageBasedOnly {
			return "free"
		}
	}
	return "" // unknown account-specific entitlement is not a free admission
}
