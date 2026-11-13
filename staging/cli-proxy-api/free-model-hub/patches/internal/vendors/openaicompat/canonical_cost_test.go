package openaicompat

import "testing"

func TestCanonicalCostTierDoesNotFollowPaidVisibility(t *testing.T) {
	a := &adapter{provider: Provider{Filter: FilterZeroPrice}}
	if got := a.modelCostTier(upstreamModel{ID: "paid", free: false}); got != "paid" {
		t.Fatal(got)
	}
	if got := a.modelCostTier(upstreamModel{ID: "free", free: true}); got != "free" {
		t.Fatal(got)
	}
}

func TestCanonicalPriceChangeOverridesFreeLabel(t *testing.T) {
	a := &adapter{provider: Provider{Filter: FilterFlagged}}
	models, err := parseModels([]byte(`{"data":[{"id":"fixture:free","isFree":true,"pricing":{"prompt":"0","completion":"1"}},{"id":"fee:free","pricing":{"prompt":"0","completion":"0","request":"1"}}]}`))
	if err != nil {
		t.Fatal(err)
	}
	for _, m := range models {
		if a.modelCostTier(m) != "paid" || m.free {
			t.Fatal("price evidence lost", m)
		}
	}
}
