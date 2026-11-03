package registry

import (
	"testing"
	"time"
)

func TestRegressionNoChargeReceiptScopeAndValidation(t *testing.T) {
	now := time.Now()
	r := NoChargeAllowance{Provider: "provider", AuthID: "account", SourceModels: []string{"model"}, Basis: "fixture no-overage constraint", VerifiedUntil: now.Add(time.Hour).UTC().Format(time.RFC3339), NoPaidOverage: true}
	if ValidateNoChargeAllowances([]NoChargeAllowance{r}) != nil || !NoChargeAllowanceValid([]NoChargeAllowance{r}, "provider", "account", "model", now) {
		t.Fatal("valid receipt refused")
	}
	if NoChargeAllowanceValid([]NoChargeAllowance{r}, "provider", "account", "model-new", now) || NoChargeAllowanceValid([]NoChargeAllowance{r}, "provider", "other-account", "model", now) {
		t.Fatal("receipt scope broadened")
	}
	r.SourceModels = []string{"*"}
	if ValidateNoChargeAllowances([]NoChargeAllowance{r}) == nil {
		t.Fatal("unbounded future models admitted")
	}
}
