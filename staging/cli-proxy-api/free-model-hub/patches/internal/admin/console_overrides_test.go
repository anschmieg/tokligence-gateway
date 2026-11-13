package admin

// Tests only the custom console keyless/base overrides; upstream suites are
// not imported or re-run.

import (
	"strings"
	"testing"
)

func TestPageWithOverridesInjectsKeylessAndBase(t *testing.T) {
	rendered := PageWithOverrides("/plugins/free-model-hub", "/admin", true)
	if !strings.Contains(rendered, `var MGMT_BASE = "/admin";`) {
		t.Fatal("MGMT_BASE must come from the injected override")
	}
	if !strings.Contains(rendered, `var KEYLESS_SAME_ORIGIN = true;`) {
		t.Fatal("keyless flag must be injected as true")
	}
	if !strings.Contains(rendered, "/plugins/free-model-hub") {
		t.Fatal("base plugin prefix must still be injected")
	}
}

func TestPageWithoutOverridesKeepsUpstreamPaths(t *testing.T) {
	rendered := PageWithOverrides("/plugins/free-model-hub", "", false)
	if !strings.Contains(rendered, `var MGMT_BASE = "";`) {
		t.Fatal("empty override must keep the page on upstream paths")
	}
	if !strings.Contains(rendered, `var KEYLESS_SAME_ORIGIN = false;`) {
		t.Fatal("keyless flag must be false by default")
	}
	if !strings.Contains(rendered, `MGMT = MGMT_BASE + "/v0/management" + BASE`) {
		t.Fatal("patched page must still derive MGMT from MGMT_BASE")
	}
}

func TestPageLegacyWrapperStaysUpstreamCompatible(t *testing.T) {
	rendered := Page("/plugins/free-model-hub")
	if strings.Contains(rendered, "/admin") && !strings.Contains(rendered, `var MGMT_BASE = "";`) {
		t.Fatal("legacy Page must behave like the empty override")
	}
}

func TestValidateManagementBase(t *testing.T) {
	cases := []struct {
		raw      string
		want     string
		wantFail bool
	}{
		{"", "", false},
		{"  ", "", false},
		{"/admin", "/admin", false},
		{"/admin/", "/admin", false},
		{"/x/y", "/x/y", false},
		{"admin", "", true},          // must be root-anchored
		{"//evil.example", "", true}, // protocol-relative widen
		{"https://evil.example/management", "", true},
		{"/admin?x=1", "", true},
		{"/admin\";alert(1)//", "", true},
		{"/admin/../", "", true},
		{"/admin#f", "", true},
		{"/a\\b", "", true},
	}
	for _, tc := range cases {
		got, err := ValidateManagementBase(tc.raw)
		if tc.wantFail {
			if err == nil {
				t.Fatalf("ValidateManagementBase(%q) = %q, want failure", tc.raw, got)
			}
			continue
		}
		if err != nil {
			t.Fatalf("ValidateManagementBase(%q) failed unexpectedly: %v", tc.raw, err)
		}
		if got != tc.want {
			t.Fatalf("ValidateManagementBase(%q) = %q, want %q", tc.raw, got, tc.want)
		}
	}
}

func TestFreehubConfigParsesDeploymentKeys(t *testing.T) {
	raw := []byte(`
keyless_accounts: false      # no public OpenCode / Kilo auto-accounts at boot
keepalive_enabled: false     # host-side refresh stays the sole token refresher
console_keyless: true
console_management_base: /admin
allowed_vendors: kilo, groq, cerebras
blocked_vendors:
  - opencodezen
  - opencodego
`)
	cfg, err := DecodePluginConfig(raw, DefaultPluginConfig())
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if cfg.ConsoleKeyless != true {
		t.Fatalf("console_keyless = %v, want true", cfg.ConsoleKeyless)
	}
	if cfg.ConsoleManagementBase != "/admin" {
		t.Fatalf("console_management_base = %q, want /admin", cfg.ConsoleManagementBase)
	}
	if cfg.KeepaliveEnabled {
		t.Fatalf("keepalive_enabled = %v, want false", cfg.KeepaliveEnabled)
	}
	if len(cfg.AllowedVendors) != 3 || cfg.AllowedVendors[0] != "kilo" {
		t.Fatalf("allowed_vendors = %v", cfg.AllowedVendors)
	}
	if len(cfg.BlockedVendors) != 2 || cfg.BlockedVendors[0] != "opencodezen" {
		t.Fatalf("blocked_vendors = %v", cfg.BlockedVendors)
	}
}

func TestFreehubConfigDefaultsPreserveUpstream(t *testing.T) {
	cfg := DefaultPluginConfig()
	if !cfg.KeepaliveEnabled {
		t.Fatal("upstream keepalive default must stay enabled in code; deployment opts out by config")
	}
	if cfg.ConsoleKeyless {
		t.Fatal("keyless console mode must default off upstream-compatible")
	}
	if cfg.ConsoleManagementBase != "" {
		t.Fatalf("console_management_base default = %q, want empty", cfg.ConsoleManagementBase)
	}
}

func TestFreehubConfigRejectsCrossOriginManagementBase(t *testing.T) {
	raw := []byte(`console_management_base: https://evil.example/management
`)
	if _, err := DecodePluginConfig(raw, DefaultPluginConfig()); err == nil {
		t.Fatal("cross-origin management base must fail config validation")
	}
}
