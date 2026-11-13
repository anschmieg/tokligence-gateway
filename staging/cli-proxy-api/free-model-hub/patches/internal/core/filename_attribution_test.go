package core

import "testing"

func TestRegistryLeadingVendorBeforeEmbeddedAccountMarker(t *testing.T) {
	r := newTestRegistry(t,
		&fakeVendor{Meta: Meta{VendorID: "cline"}},
		&fakeVendor{Meta: Meta{VendorID: "github"}},
		&fakeVendor{Meta: Meta{VendorID: "workbuddyglobal"}})
	for _, tc := range []struct{ name, want string }{
		{"cline-user@github.example.json", "cline"},
		{"cline-user-workbuddyglobal.json", "cline"},
		{"github-user-cline.json", "github"},
		{"cline.json", "cline"},
		{"cline_user.github.json", "cline"},
		{"my-cline.json", "cline"},
	} {
		v, ok := r.Resolve(tc.name, "freehub", nil)
		if !ok || v.ID() != tc.want {
			t.Fatalf("wrong owner for %q; want %s", tc.name, tc.want)
		}
	}
	v, ok := r.Resolve("cline-user@github.example.json", "freehub", map[string]any{"vendor": "github"})
	if !ok || v.ID() != "github" {
		t.Fatal("explicit persisted vendor must retain precedence")
	}
}
