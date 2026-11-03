package cline

func canonicalCostTier(cost string) string {
	switch cost {
	case CostFree:
		return "free"
	case CostPass:
		return "included"
	}
	return ""
}
