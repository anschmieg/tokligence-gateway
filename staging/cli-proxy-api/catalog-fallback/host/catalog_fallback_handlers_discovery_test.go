package handlers

import (
	"encoding/json"
	"github.com/gin-gonic/gin"
	claudemodels "github.com/router-for-me/CLIProxyAPI/v8/internal/client/claude/models"
	codexmodels "github.com/router-for-me/CLIProxyAPI/v8/internal/client/codex/models"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/registry"
	"net/http/httptest"
	"reflect"
	"testing"
)

func TestProfileCodexDiscoveryPreservesNativeOptions(t *testing.T) {
	h, _ := profileFixture(t, nil)
	full := codexmodels.BuildResponse(registry.GetGlobalRegistry().GetAvailableModels("openai"), nil, false)
	baselineRaw, _ := json.Marshal(full)
	var before map[string]any
	_ = json.Unmarshal(baselineRaw, &before)
	bySlug := map[string]any{}
	for _, row := range before["models"].([]any) {
		r := row.(map[string]any)
		bySlug[r["slug"].(string)] = row
	}
	rec := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(rec)
	req := httptest.NewRequest("GET", "/coding/v1/models?client_version=0.100.0", nil)
	c.Request = req.WithContext(registry.WithModelProfile(req.Context(), "coding"))
	h.WriteModelListResponse(c, "openai", full)
	var after map[string]any
	if json.Unmarshal(rec.Body.Bytes(), &after) != nil {
		t.Fatal(rec.Body.String())
	}
	rows, ok := after["models"].([]any)
	if rec.Code != 200 || !ok || len(rows) != 2 || after["profile"] != "coding" {
		t.Fatal(rec.Code, after)
	}
	for _, row := range rows {
		r := row.(map[string]any)
		if !reflect.DeepEqual(row, bySlug[r["slug"].(string)]) {
			t.Fatal("native Codex option set changed", row)
		}
	}
}
func TestProfileAnthropicDiscoveryKeepsReversibleAliases(t *testing.T) {
	h, _ := profileFixture(t, nil)
	full := claudemodels.BuildResponse(registry.GetGlobalRegistry().GetAvailableModels("claude"), false)
	rec := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(rec)
	req := httptest.NewRequest("GET", "/coding/v1/models", nil)
	c.Request = req.WithContext(registry.WithModelProfile(req.Context(), "coding"))
	h.WriteModelListResponse(c, "claude", full)
	var after map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &after)
	rows, ok := after["data"].([]any)
	if rec.Code != 200 || !ok || len(rows) != 2 {
		t.Fatal(rec.Code, after)
	}
	for _, row := range rows {
		r := row.(map[string]any)
		id := r["id"].(string)
		canonical := claudemodels.ResolveClaudeModelIDPrefix(id)
		if canonical != "glm-4.7-flash" && canonical != "glm-5.3-flash" {
			t.Fatal("irreversible alias", r)
		}
		if r["routing_policy"] != "preferred-then-similar-session-billing" {
			t.Fatal(r)
		}
	}
	if after["first_id"] != rows[0].(map[string]any)["id"] || after["last_id"] != rows[len(rows)-1].(map[string]any)["id"] {
		t.Fatal("native catalog boundaries changed", after)
	}
}
func TestProfileCannotBeSelectedByForgedHeaderOnFullCatalog(t *testing.T) {
	h, _ := profileFixture(t, nil)
	full := map[string]any{"object": "list", "data": []map[string]any{{"id": "not-a-coding-model", "object": "model"}}}
	rec := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(rec)
	c.Request = httptest.NewRequest("GET", "/v1/models", nil)
	c.Request.Header.Set("X-Gateway-Profile", "coding")
	h.WriteModelListResponse(c, "openai", full)
	var after map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &after)
	if rec.Code != 200 || len(after["data"].([]any)) != 3 || after["profile"] != nil {
		t.Fatal(rec.Code, after)
	}
}

func TestSessionVirtualAliasesRetainOpenAIModelEnvelope(t *testing.T) {
	h, _ := profileFixture(t, nil)
	rec := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(rec)
	c.Request = httptest.NewRequest("GET", "/v1/models", nil)
	h.WriteModelListResponse(c, "openai", map[string]any{"object": "list", "data": []any{}})
	var out map[string]any
	json.Unmarshal(rec.Body.Bytes(), &out)
	rows := out["data"].([]any)
	if len(rows) != 2 {
		t.Fatal(out)
	}
	for _, row := range rows {
		r := row.(map[string]any)
		if r["object"] != "model" || r["created"] != float64(0) || r["owned_by"] != "gateway" || r["virtual"] != true {
			t.Fatal(r)
		}
	}
}
