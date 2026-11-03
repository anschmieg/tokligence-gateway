package registry

import "testing"

func TestCanonicalDiscoveryHidesOverridesButKeepsRouting(t *testing.T) {
	r := GetGlobalRegistry()
	clients := []string{"canonical-a", "canonical-b", "canonical-paid"}
	defer func() {
		for _, c := range clients {
			r.UnregisterClient(c)
		}
	}()
	r.RegisterClient(clients[0], "freehub", []*ModelInfo{{ID: "shared", CanonicalID: "shared", OwnedBy: "kilo", ContextLength: 1000, SupportedParameters: []string{"tools", "temperature"}, CanonicalSourceID: "kilo/source"}, {ID: "kilo/source", CanonicalID: "shared", OwnedBy: "kilo", HideFromDiscovery: true}})
	r.RegisterClient(clients[1], "freehub", []*ModelInfo{{ID: "shared", CanonicalID: "shared", OwnedBy: "nvidia", ContextLength: 500, SupportedParameters: []string{"tools"}, CanonicalSourceID: "nvidia/source"}, {ID: "nvidia/source", CanonicalID: "shared", OwnedBy: "nvidia", HideFromDiscovery: true}})
	r.RegisterClient(clients[2], "paid", []*ModelInfo{{ID: "shared", CanonicalID: "shared", OwnedBy: "paid", HideFromDiscovery: true}, {ID: "orca/shared", CanonicalID: "paygo/shared", OwnedBy: "paid", HideFromDiscovery: true, CanonicalSourceID: "shared"}})
	for _, format := range []string{"openai", "claude", "gemini"} {
		for _, m := range r.GetAvailableModels(format) {
			id, _ := m["id"].(string)
			name, _ := m["name"].(string)
			if id == "kilo/source" || name == "models/kilo/source" {
				t.Fatal("override leaked", format, m)
			}
		}
	}
	if !r.ClientSupportsModel(clients[0], "kilo/source") || len(r.GetModelProviders("kilo/source")) != 1 {
		t.Fatal("hidden override unroutable")
	}
	if r.ClientSupportsModel(clients[2], "shared") {
		t.Fatal("hidden paid collision entered canonical pool")
	}
	if !r.ClientSupportsModel(clients[2], "orca/shared") {
		t.Fatal("explicit paid override unavailable")
	}
	if got := r.GetModelProviders("shared"); len(got) != 1 || got[0] != "freehub" {
		t.Fatal(got)
	}
	info := r.GetModelInfo("shared", "")
	if info.ContextLength != 500 || len(info.SupportedParameters) != 1 || info.SupportedParameters[0] != "tools" {
		t.Fatal("credential intersection lost", info)
	}
	if r.CanonicalRouteSource(clients[0], "shared") != "kilo/source" || r.CanonicalRouteSource(clients[1], "shared") != "nvidia/source" {
		t.Fatal("source crossed credential")
	}
	r.UnregisterClient(clients[1])
	if info := r.GetModelInfo("shared", ""); info.ContextLength != 1000 {
		t.Fatal("removed source still constrains contract", info)
	}
}

func TestCanonicalStaticCatalogCannotRepublishRawOverrides(t *testing.T) {
	r := GetGlobalRegistry()
	setCanonicalDiscoveryOnly(true)
	defer setCanonicalDiscoveryOnly(false)
	defer r.UnregisterClient("canonical-static")
	defer r.UnregisterClient("canonical-real")
	r.RegisterClient("canonical-static", "plugin-static", []*ModelInfo{{ID: "kilo/source"}})
	r.RegisterClient("canonical-real", "freehub", []*ModelInfo{{ID: "kilo/source", CanonicalID: "source", CanonicalPolicy: "override", HideFromDiscovery: true}, {ID: "source", CanonicalID: "source", CanonicalPolicy: "canonical"}})
	for _, m := range r.GetAvailableModelInfos() {
		if m.ID == "kilo/source" {
			t.Fatal("static raw ID leaked")
		}
	}
	r.UnregisterClient("canonical-real")
	for _, m := range r.GetAvailableModelInfos() {
		if m.ID == "kilo/source" {
			t.Fatal("stale static ID leaked after source removal")
		}
	}
	if !r.ClientSupportsModel("canonical-static", "kilo/source") {
		t.Fatal("explicit override registration removed")
	}
}
