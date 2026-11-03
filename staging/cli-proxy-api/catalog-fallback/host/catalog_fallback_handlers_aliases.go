package handlers

import (
	"encoding/json"
	"github.com/gin-gonic/gin"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/registry"
	"sort"
)

func (h *BaseAPIHandler) appendProfileAliases(c *gin.Context, body []byte) []byte {
	if c.Request == nil || registry.ModelProfileFromContext(c.Request.Context()) != "" || h.AuthManager == nil || !h.AuthManager.CanonicalRoutingEnabled() {
		return body
	}
	var root map[string]json.RawMessage
	if json.Unmarshal(body, &root) != nil || string(root["object"]) != `"list"` {
		return body
	}
	var rows []map[string]any
	if json.Unmarshal(root["data"], &rows) != nil {
		return body
	}
	profiles := h.AuthManager.CanonicalRoutingPolicy().Profiles
	if len(profiles) == 0 {
		profiles = map[string]registry.ModelProfile{"chat": {}, "coding": {}}
	}
	names := []string{}
	for name := range profiles {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		if registry.GetGlobalRegistry().GetModelInfo(name, "") != nil {
			continue
		}
		rows = append(rows, map[string]any{"id": name, "object": "model", "created": 0, "owned_by": "gateway", "display_name": name + " routing profile", "virtual": true, "model_role": "profile", "profile": name, "routing_policy": "preferred-then-similar-session-billing", "default_billing_policy": "SUB", "preferred_model": profiles[name].PreferredModel})
	}
	root["data"], _ = json.Marshal(rows)
	out, e := json.Marshal(root)
	if e != nil {
		return body
	}
	return out
}
