package core

// Distributed alongside registry_admission.go by the tokligence staged
// prepare_free_model_hub.py. Tests only the custom admission behaviour; no
// upstream test suites are imported or re-run.

import (
	"context"
	"reflect"
	"testing"

	"free-model-hub/cpasdk/pluginapi"
)

type admissionFakeVendor struct{ id string }

func (v *admissionFakeVendor) ID() string   { return v.id }
func (v *admissionFakeVendor) Name() string { return v.id }
func (v *admissionFakeVendor) Region() string {
	return ""
}
func (v *admissionFakeVendor) ModelPrefix() string { return "" }
func (v *admissionFakeVendor) Match(string, string, map[string]any) bool {
	return false
}
func (v *admissionFakeVendor) Parse(_ []byte, _ string) (*Credential, error) {
	return nil, nil
}
func (v *admissionFakeVendor) StaticModels(_ context.Context) ([]pluginapi.ModelInfo, error) {
	return nil, nil
}
func (v *admissionFakeVendor) Execute(_ context.Context, _ *Credential, _ *ExecuteRequest) (*pluginapi.ExecutorResponse, error) {
	return nil, nil
}
func (v *admissionFakeVendor) ExecuteStream(_ context.Context, _ *Credential, _ *ExecuteRequest, _ StreamSink) error {
	return nil
}

func newAdmissionRegistry(t *testing.T) *Registry {
	t.Helper()
	r := NewRegistry()
	for _, id := range []string{"kilo", "originalvendor1", "originalvendor2"} {
		if err := r.Register(&admissionFakeVendor{id: id}); err != nil {
			t.Fatalf("register %s: %v", id, err)
		}
	}
	return r
}

func activeIDs(r *Registry) []string {
	out := []string{}
	for _, v := range r.Vendors() {
		out = append(out, v.ID())
	}
	return out
}

func TestApplyAdmissionBlockedListStillActiveWhenAllowedEmpty(t *testing.T) {
	r := newAdmissionRegistry(t)
	r.ApplyAdmission(nil, []string{"originalvendor2"})
	if want := []string{"kilo", "originalvendor1"}; !reflect.DeepEqual(activeIDs(r), want) {
		t.Fatalf("active after block = %v, want %v", activeIDs(r), want)
	}
	if parked := r.ParkedIDs(); !reflect.DeepEqual(parked, []string{"originalvendor2"}) {
		t.Fatalf("parked = %v, want [originalvendor2]", parked)
	}
}

func TestApplyAdmissionAllowlistAndRestore(t *testing.T) {
	r := newAdmissionRegistry(t)
	r.ApplyAdmission([]string{"kilo", "originalvendor1"}, nil)
	if want := []string{"kilo", "originalvendor1"}; !reflect.DeepEqual(activeIDs(r), want) {
		t.Fatalf("active after allowlist = %v, want %v", activeIDs(r), want)
	}
	// Later admission restores parked code without re-registration.
	r.ApplyAdmission([]string{"kilo", "originalvendor1", "originalvendor2"}, nil)
	if want := []string{"kilo", "originalvendor1", "originalvendor2"}; !reflect.DeepEqual(activeIDs(r), want) {
		t.Fatalf("active after restore = %v, want %v", activeIDs(r), want)
	}
	if parked := r.ParkedIDs(); len(parked) != 0 {
		t.Fatalf("parked after restore = %v, want empty", parked)
	}
}

func TestApplyAdmissionResolvedClaimingSkipsParked(t *testing.T) {
	r := newAdmissionRegistry(t)
	r.ApplyAdmission(nil, []string{"originalvendor1"})
	if _, ok := r.ByID("originalvendor1"); ok {
		t.Fatal("ByID must not surface a parked vendor")
	}
	if _, ok := r.Resolve("originalvendor1-account.json", "", nil); ok {
		t.Fatal("Resolve must not attribute to a parked vendor")
	}
	if got := r.Known("originalvendor1"); !got {
		t.Fatal("Known must still report a parked ID")
	}
}

func TestApplyAdmissionEmptyListsKeepUpstreamDefault(t *testing.T) {
	r := newAdmissionRegistry(t)
	r.ApplyAdmission(nil, nil)
	if want := []string{"kilo", "originalvendor1", "originalvendor2"}; !reflect.DeepEqual(activeIDs(r), want) {
		t.Fatalf("active with no admission config = %v, want upstream default %v", activeIDs(r), want)
	}
	if parked := r.ParkedIDs(); len(parked) != 0 {
		t.Fatalf("parked with no admission config = %v, want empty", parked)
	}
}

func TestApplyAdmissionCaseAndWhitespaceNormalization(t *testing.T) {
	r := newAdmissionRegistry(t)
	r.ApplyAdmission([]string{" Kilo ", "  ", ""}, []string{" ORIGINALVENDOR2 "})
	if want := []string{"kilo"}; !reflect.DeepEqual(activeIDs(r), want) {
		t.Fatalf("active after normalization = %v, want %v", activeIDs(r), want)
	}
}
