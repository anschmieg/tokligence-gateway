package openaicompat

import "testing"

func TestZaiOnlyDocumentedFreeModels(t *testing.T) {
	listed := []upstreamModel{{ID: "glm-5.3-flash", free: true}, {ID: "glm-4.7-flash", ContextLength: 200000}, {ID: "glm-4.7-flashx"}, {ID: "glm-4.6v-flash"}}
	filtered := filterModels(listed, FilterFlash, false)
	if len(filtered) != 2 {
		t.Fatalf("paid Flash models admitted: %v", filtered)
	}
	got := completeZaiFreeCatalog(filtered)
	if len(got) != 3 || got[0].ID != "glm-4.7-flash" || got[1].ID != "glm-4.5-flash" || got[2].ID != "glm-4.6v-flash" {
		t.Fatal("documented catalog differs")
	}
	if got[0].ContextLength != 200000 {
		t.Fatal("available metadata discarded")
	}
	for _, model := range got {
		if model.ID == "glm-5.3-flash" || model.ID == "glm-4.7-flashx" {
			t.Fatal("paid model admitted")
		}
	}
}
func TestZaiDocumentedFreeCatalogWhenOmitted(t *testing.T) {
	if len(completeZaiFreeCatalog(nil)) != 3 {
		t.Fatal("documented models missing")
	}
}
