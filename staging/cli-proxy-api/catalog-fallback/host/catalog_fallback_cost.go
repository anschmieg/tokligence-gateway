package registry

import (
	"errors"
	"strings"
	"time"
)

// NoChargeAllowance is an operator-owned, bounded attestation of a verified
// account/endpoint billing constraint. It is not inferred from OAuth or price
// guesses. It cannot disable provider billing: the documented provider-side
// no-overage restriction must actually be enabled before configuring it.
type NoChargeAllowance struct {
	Provider      string   `yaml:"provider" json:"provider"`
	AuthID        string   `yaml:"auth-id" json:"auth-id"`
	SourceModels  []string `yaml:"source-models" json:"source-models"`
	Basis         string   `yaml:"basis" json:"basis"`
	VerifiedUntil string   `yaml:"verified-until" json:"verified-until"`
	NoPaidOverage bool     `yaml:"no-paid-overage" json:"no-paid-overage"`
}

func ValidateNoChargeAllowances(receipts []NoChargeAllowance) error {
	seen := map[string]bool{}
	for _, r := range receipts {
		expiry, err := time.Parse(time.RFC3339, r.VerifiedUntil)
		if r.Provider == "" || r.AuthID == "" || r.Basis == "" || len(r.SourceModels) == 0 || !r.NoPaidOverage || err != nil || expiry.IsZero() {
			return errors.New("no-charge allowance needs exact provider/auth/models, billing evidence, expiry and disabled paid overage")
		}
		for _, source := range r.SourceModels {
			if source == "" || strings.ContainsAny(source, "*\x00\r\n") {
				return errors.New("no-charge allowance model must be an exact source ID")
			}
			key := r.Provider + "\x00" + r.AuthID + "\x00" + source
			if seen[key] {
				return errors.New("duplicate no-charge allowance scope")
			}
			seen[key] = true
		}
	}
	return nil
}
func NoChargeAllowanceValid(receipts []NoChargeAllowance, provider, auth, source string, now time.Time) bool {
	for _, r := range receipts {
		if r.Provider != provider || r.AuthID != auth || !r.NoPaidOverage || r.Basis == "" {
			continue
		}
		until, err := time.Parse(time.RFC3339, r.VerifiedUntil)
		if err != nil || !now.Before(until) {
			continue
		}
		for _, id := range r.SourceModels {
			if id == source {
				return true
			}
		}
	}
	return false
}
