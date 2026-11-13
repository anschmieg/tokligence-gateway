package openaicompat

// Explicit zero-price IDs from docs.z.ai/guides/overview/pricing (2026-11-02).
// Flash is not a pricing category: GLM5.3Flash is paid. Supplement supported
// free IDs omitted by an otherwise successful authenticated catalog response.
// Publication does not claim account entitlement or perform an inference probe.
func completeZaiFreeCatalog(listed []upstreamModel) []upstreamModel {
	ids := []string{"glm-4.7-flash", "glm-4.5-flash", "glm-4.6v-flash"}
	out := make([]upstreamModel, 0, len(ids))
	for _, id := range ids {
		model := upstreamModel{ID: id, Name: id, free: true}
		for _, entry := range listed {
			if entry.ID == id {
				model = entry
				break
			}
		}
		out = append(out, model)
	}
	return out
}
