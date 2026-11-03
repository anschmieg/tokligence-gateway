package handlers

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"sort"

	"github.com/gin-gonic/gin"
	claudemodels "github.com/router-for-me/CLIProxyAPI/v8/internal/client/claude/models"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/registry"
)

// Filter the NATIVE final catalog so Codex compact fields, Anthropic aliases,
// capabilities and response interceptors are preserved. A task view is not a
// competing serializer or a new interpretation of each client's model schema.
func (h *BaseAPIHandler) filterProfileModelList(c *gin.Context, body []byte) ([]byte, int) {
	if c.Request == nil {
		return body, 200
	}
	name := registry.ModelProfileFromContext(c.Request.Context())
	if name == "" {
		return body, 200
	}
	view, status := h.ProfileModels(name)
	if status != 200 {
		raw, _ := json.Marshal(view)
		return raw, status
	}
	allowed := map[string]map[string]any{}
	order := map[string]int{}
	for i, row := range view["data"].([]map[string]any) {
		id, _ := row["id"].(string)
		allowed[id] = row
		order[id] = i
	}
	var root map[string]json.RawMessage
	if json.Unmarshal(body, &root) != nil {
		return []byte(`{"error":"invalid native model catalog"}`), 502
	}
	key := "data"
	if _, ok := root["models"]; ok {
		key = "models"
	}
	var rows []json.RawMessage
	if json.Unmarshal(root[key], &rows) != nil {
		return []byte(`{"error":"unsupported native model catalog"}`), 502
	}
	type item struct {
		raw           json.RawMessage
		id, canonical string
	}
	kept := []item{}
	for _, raw := range rows {
		var row map[string]any
		if json.Unmarshal(raw, &row) != nil {
			continue
		}
		id, _ := row["id"].(string)
		if id == "" {
			id, _ = row["slug"].(string)
		}
		canonical := claudemodels.ResolveClaudeModelIDPrefix(id)
		meta, ok := allowed[canonical]
		if !ok {
			continue
		}
		if key == "data" {
			for _, field := range []string{"profile", "model_role", "task", "cost_policy", "routing_policy", "selection_reason", "credential_priority"} {
				row[field] = meta[field]
			}
			raw, _ = json.Marshal(row)
		}
		kept = append(kept, item{raw, id, canonical})
	}
	sort.SliceStable(kept, func(i, j int) bool { return order[kept[i].canonical] < order[kept[j].canonical] })
	filtered := []json.RawMessage{}
	for _, row := range kept {
		filtered = append(filtered, row.raw)
	}
	root[key], _ = json.Marshal(filtered)
	if _, ok := root["first_id"]; ok {
		first, last := "", ""
		if len(kept) > 0 {
			first = kept[0].id
			last = kept[len(kept)-1].id
		}
		root["first_id"], _ = json.Marshal(first)
		root["last_id"], _ = json.Marshal(last)
	}
	for _, field := range []string{"profile", "task", "cost_policy", "policy_version", "full_catalog", "model_role", "evidence_stale"} {
		root[field], _ = json.Marshal(view[field])
	}
	output, err := json.Marshal(root)
	if err != nil {
		return []byte(`{"error":"profile catalog serialization failed"}`), 500
	}
	sum := sha256.Sum256(output)
	c.Writer.Header().Del("Content-Length")
	c.Header("ETag", `"`+hex.EncodeToString(sum[:])+`"`)
	return output, 200
}
