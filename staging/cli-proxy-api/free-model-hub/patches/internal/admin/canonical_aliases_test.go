package admin

import (
	"free-model-hub/cpasdk/pluginapi"
	"testing"
)

func TestCanonicalAliasRetainsQualifiedIDAndVendorReverse(t *testing.T) {
	c := newTestCatalog(t)
	c.Configure(ModelSettings{ModelNameTag: ModelNameTagPrefix})
	source := []pluginapi.ModelInfo{{ID: "kilo/nvidia/nemotron-3.5-lightning:free"}}
	c.CacheProbedModels("kilo", source)
	got := c.ApplyAliases("kilo", source)
	if len(got) != 2 || got[0].ID != "kilo-kilo/nvidia/nemotron-3.5-lightning:free" || got[1].ID != "nemotron-3.5-lightning" {
		t.Fatal(got)
	}
	for _, id := range []string{got[0].ID, got[1].ID} {
		if upstream := c.ResolveOutboundModel("kilo", id); upstream != source[0].ID {
			t.Fatalf("%s -> %s", id, upstream)
		}
	}
	if foreign := c.ResolveOutboundModel("cline", got[1].ID); foreign != got[1].ID {
		t.Fatal(foreign)
	}
	c.aliases["kilo:"+source[0].ID] = "operator-choice"
	if got := c.ApplyAliases("kilo", source); got[1].ID != "operator-choice" {
		t.Fatal(got)
	}
	if got := c.ResolveOutboundModel("kilo", "nemotron-3.5-lightning"); got != "nemotron-3.5-lightning" {
		t.Fatal("operator override ignored", got)
	}
}
func TestCanonicalAliasMissingSourceDoesNotRoute(t *testing.T) {
	c := newTestCatalog(t)
	if got := c.ResolveOutboundModel("kilo", "nemotron-3.5-lightning"); got != "nemotron-3.5-lightning" {
		t.Fatal(got)
	}
}
