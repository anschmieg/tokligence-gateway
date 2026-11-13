package admin

import "testing"

func TestFreeHubNativeFlowConfig(t *testing.T) {
	for _, raw := range []string{
		`{"blocked_vendors":["opencodezen","opencodego","openrouter"],"keepalive_enabled":false,"console_keyless":true,"console_management_base":"/admin","state_dir":"/work/state"}`,
		`{blocked_vendors: [opencodezen, opencodego, openrouter], keepalive_enabled: false, console_keyless: true, console_management_base: /admin, state_dir: /work/state}`,
	} {
		cfg, err := DecodePluginConfig([]byte(raw), DefaultPluginConfig())
		if err != nil {
			t.Fatal(err)
		}
		if len(cfg.BlockedVendors) != 3 || cfg.KeepaliveEnabled || !cfg.ConsoleKeyless || cfg.ConsoleManagementBase != "/admin" || cfg.StateDir != "/work/state" {
			t.Fatal("native flow-style config was silently ignored")
		}
	}
	for _, raw := range []string{`[]`, `{"unterminated":`} {
		if _, err := DecodePluginConfig([]byte(raw), DefaultPluginConfig()); err == nil {
			t.Fatal("malformed config silently admitted")
		}
	}
}
