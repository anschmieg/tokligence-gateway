package app

import (
	"free-model-hub/cpasdk/pluginapi"
	"testing"
)

func TestCanonicalCostIsPerCredentialAndRevokedOnRefresh(t *testing.T) {
	l := &canonicalCostLedger{}
	l.Set("a", "vendor", []pluginapi.ModelInfo{{ID: "source", CostTier: "free"}})
	l.Set("b", "vendor", []pluginapi.ModelInfo{{ID: "source", CostTier: "paid"}})
	if !l.Admitted("a", "vendor", "source", "free", true) || l.Admitted("b", "vendor", "source", "free", true) {
		t.Fatal("account cost grants crossed")
	}
	l.Set("a", "vendor", []pluginapi.ModelInfo{{ID: "source", CostTier: "paid"}})
	if l.Admitted("a", "vendor", "source", "free", true) || l.Admitted("a", "vendor", "source", "paid", true) {
		t.Fatal("reprice retained a free grant")
	}
	if !l.Admitted("a", "vendor", "source", "paid", false) {
		t.Fatal("paid admission lost")
	}
	l.Set("a", "vendor", nil)
	if l.Admitted("a", "vendor", "source", "paid", false) {
		t.Fatal("empty refresh retained grant")
	}
	if !l.Admitted("b", "vendor", "source", "paid", false) {
		t.Fatal("empty refresh on a affected b")
	}
}
func TestCanonicalCostUnknownCannotGrantFree(t *testing.T) {
	l := &canonicalCostLedger{}
	l.Set("a", "vendor", []pluginapi.ModelInfo{{ID: "source"}})
	if l.Admitted("a", "vendor", "source", "", true) || l.Admitted("a", "other", "source", "", false) || l.Admitted("missing", "vendor", "source", "", false) {
		t.Fatal("unknown or foreign scope admitted")
	}
}
