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

func TestOperatorAliasFollowsCatalogRemovalAndReturn(t *testing.T) {
	c := newTestCatalog(t)
	c.Configure(ModelSettings{ModelNameTag: ModelNameTagPrefix})
	source := []pluginapi.ModelInfo{{ID: "llm7/GLM-5.3-Flash"}}
	c.CacheProbedModels("llm7", source)
	c.SetAlias("llm7", source[0].ID, "glm-5.3-flash")
	got := c.ApplyAliases("llm7", source)
	if len(got) != 2 || got[0].ID != "llm7-llm7/GLM-5.3-Flash" || got[1].ID != "glm-5.3-flash" {
		t.Fatal(got)
	}
	if got := c.ResolveOutboundModel("llm7", "glm-5.3-flash"); got != source[0].ID {
		t.Fatal(got)
	}
	other := []pluginapi.ModelInfo{{ID: "llm7/other-model"}}
	c.CacheProbedModels("llm7", other)
	for _, m := range c.ApplyAliases("llm7", other) {
		if m.ID == "glm-5.3-flash" {
			t.Fatal("removed canonical retained")
		}
	}
	if got := c.ResolveOutboundModel("llm7", "glm-5.3-flash"); got != "glm-5.3-flash" {
		t.Fatal("stale reverse alias", got)
	}
	c.CacheProbedModels("llm7", source)
	if got := c.ApplyAliases("llm7", source); len(got) != 2 || got[1].ID != "glm-5.3-flash" {
		t.Fatal("source return not restored", got)
	}
	if got := c.ApplyAliases("llm7", nil); len(got) != 0 {
		t.Fatal("empty runtime catalog retained an alias")
	}
	if got := c.ResolveOutboundModel("kilo", "glm-5.3-flash"); got != "glm-5.3-flash" {
		t.Fatal("alias crossed vendor boundary")
	}
}
