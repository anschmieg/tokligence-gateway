package handlers

import (
	"encoding/json"
	"errors"
	"net/http"
	"sort"
	"strings"

	"github.com/router-for-me/CLIProxyAPI/v8/internal/interfaces"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/registry"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/thinking"
	log "github.com/sirupsen/logrus"
	"github.com/tidwall/sjson"
	"golang.org/x/net/context"
)

type canonicalAttemptContextKey struct{}
type canonicalAttemptContext struct {
	Excluded []string
	Route    string
	Bindings map[string]registry.CanonicalDispatchBinding
	Permit   *registry.CanonicalDispatchPermit
}
type canonicalRequirements struct {
	Bytes, Output                    int
	Tools, JSON, Reasoning, Parallel bool
	ToolChoice                       bool
	Outputs                          map[string]bool
	Modalities                       map[string]bool
}
type canonicalStage struct {
	Model       string
	Tier        int
	Alternative bool
}
type canonicalPlan struct {
	Requested, Base, Policy, Suffix string
	Stages                          []canonicalStage
	Limit                           int
	Requirements                    canonicalRequirements
}

func canonicalFamily(id string) string {
	for _, family := range []string{"glm", "gemini", "claude", "gpt-oss", "gpt", "nemotron", "llama", "qwen", "mistral", "minimax", "deepseek", "kimi", "beam"} {
		if strings.HasPrefix(id, family+"-") || id == family {
			return family
		}
	}
	return "default"
}
func canonicalInput(model string) (base, suffix string, freeOnly, ok bool) {
	parsed := thinking.ParseSuffix(model)
	name := parsed.ModelName
	suffix = strings.TrimPrefix(model, name)
	if strings.HasSuffix(name, ":free") {
		freeOnly = true
		name = strings.TrimSuffix(name, ":free")
	}
	info := registry.GetGlobalRegistry().GetModelInfo(name, "")
	if info == nil || info.CanonicalID != name || info.CanonicalPolicy != "canonical" {
		return "", "", false, false
	}
	return name, suffix, freeOnly, true
}
func canonicalRequestRequirements(raw []byte) (canonicalRequirements, error) {
	r := canonicalRequirements{Bytes: len(raw), Modalities: map[string]bool{"text": true}, Outputs: map[string]bool{"text": true}}
	var root map[string]any
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &root); err != nil {
			return r, err
		}
	}
	for _, k := range []string{"max_tokens", "max_completion_tokens", "max_output_tokens"} {
		if n, ok := root[k].(float64); ok && n > float64(r.Output) {
			r.Output = int(n)
		}
	}
	if a, ok := root["tools"].([]any); ok && len(a) > 0 {
		r.Tools = true
	}
	if a, ok := root["functions"].([]any); ok && len(a) > 0 {
		r.Tools = true
	}
	if x, ok := root["parallel_tool_calls"].(bool); ok {
		r.Parallel = x
	}
	if v := root["response_format"]; v != nil {
		r.JSON = true
	}
	if v := root["reasoning_effort"]; v != nil {
		r.Reasoning = true
	}
	if v := root["thinking"]; v != nil {
		r.Reasoning = true
	}
	if v := root["output_config"]; v != nil {
		r.JSON = true
	}
	if v := root["tool_choice"]; v != nil && v != "none" {
		r.Tools = true
		r.ToolChoice = true
	}
	if v := root["reasoning"]; v != nil {
		r.Reasoning = true
	}
	if modes, ok := root["modalities"].([]any); ok {
		for _, v := range modes {
			if mode, ok := v.(string); ok {
				r.Outputs[mode] = true
			}
		}
	}
	var walk func(any)
	walk = func(v any) {
		switch x := v.(type) {
		case map[string]any:
			if typ, ok := x["type"].(string); ok {
				switch typ {
				case "input_file", "file", "document":
					r.Modalities["file"] = true
				case "json_schema", "json_object":
					r.JSON = true
				case "image", "image_url", "input_image":
					r.Modalities["image"] = true
				case "input_audio", "audio":
					r.Modalities["audio"] = true
				case "video", "video_url", "input_video":
					r.Modalities["video"] = true
				}
			}
			if _, ok := x["fileData"]; ok {
				r.Modalities["file"] = true
			}
			if _, ok := x["inlineData"]; ok {
				r.Modalities["file"] = true
			}
			if _, ok := x["file_data"]; ok {
				r.Modalities["file"] = true
			}
			if modes, ok := x["responseModalities"].([]any); ok {
				for _, v := range modes {
					if mode, ok := v.(string); ok {
						r.Outputs[strings.ToLower(mode)] = true
					}
				}
			}
			if n, ok := x["maxOutputTokens"].(float64); ok && n > float64(r.Output) {
				r.Output = int(n)
			}
			if mime, ok := x["responseMimeType"].(string); ok && mime != "text/plain" {
				r.JSON = true
			}
			if mime, ok := x["mimeType"].(string); ok {
				for _, m := range []string{"image", "audio", "video"} {
					if strings.HasPrefix(mime, m+"/") {
						r.Modalities[m] = true
					}
				}
			}
			if v := x["functionDeclarations"]; v != nil {
				r.Tools = true
			}
			if v := x["responseSchema"]; v != nil {
				r.JSON = true
			}
			if v := x["thinkingConfig"]; v != nil {
				r.Reasoning = true
			}
			for _, value := range x {
				walk(value)
			}
		case []any:
			for _, value := range x {
				walk(value)
			}
		}
	}
	walk(root)
	return r, nil
}
func containsCanonical(values []string, value string) bool {
	for _, v := range values {
		if strings.EqualFold(v, value) {
			return true
		}
	}
	return false
}
func canonicalCompatible(info *registry.ModelInfo, r canonicalRequirements) bool {
	if info == nil || !info.CanonicalFree {
		return false
	}
	// Cross-model substitution is restricted to declared text-output models.
	if !containsCanonical(info.SupportedOutputModalities, "text") {
		return false
	}
	for modality := range r.Outputs {
		if !containsCanonical(info.SupportedOutputModalities, modality) {
			return false
		}
	}
	if r.ToolChoice && !containsCanonical(info.SupportedParameters, "tool_choice") {
		return false
	}
	for modality := range r.Modalities {
		if !containsCanonical(info.SupportedInputModalities, modality) {
			return false
		}
	}
	if r.Tools && !containsCanonical(info.SupportedParameters, "tools") {
		return false
	}
	if r.Parallel && !containsCanonical(info.SupportedParameters, "parallel_tool_calls") {
		return false
	}
	if r.JSON && !containsCanonical(info.SupportedParameters, "response_format") {
		return false
	}
	if r.Reasoning && info.Thinking == nil && !containsCanonical(info.SupportedParameters, "reasoning") && !containsCanonical(info.SupportedParameters, "reasoning_effort") {
		return false
	}
	// Byte length overestimates text token counts. Opaque media size cannot be
	// established from a URL, so automatic cross-model media substitution is denied.
	if len(r.Modalities) > 1 {
		return false
	}
	limit := info.ContextLength
	if limit <= 0 {
		limit = info.InputTokenLimit
	}
	if limit <= 0 || limit < r.Bytes+r.Output {
		return false
	}
	if r.Output > 0 {
		out := info.MaxCompletionTokens
		if out <= 0 {
			out = info.OutputTokenLimit
		}
		if out <= 0 || out < r.Output {
			return false
		}
	}
	return true
}
func canonicalRankedFallbacks(base string, r canonicalRequirements, p registry.CanonicalRoutingConfig) []string {
	family := canonicalFamily(base)
	preferred := p.FreeFallbacks[family]
	if len(preferred) == 0 {
		switch family {
		case "glm":
			preferred = []string{"glm-4.7-flash", "glm-4.5-flash", "beam-free"}
		case "gemini":
			preferred = []string{"gemini-3.8-flash", "gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "nemotron-3.5-lightning", "beam-free"}
		default:
			preferred = []string{"nemotron-3.5-lightning", "beam-free", "glm-4.7-flash"}
		}
	}
	ranks := map[string]int{}
	for i, id := range preferred {
		ranks[id] = i
	}
	type candidate struct {
		id   string
		rank int
	}
	all := []candidate{}
	for _, info := range registry.GetGlobalRegistry().GetAvailableModelInfos() {
		id := info.ID
		if id == base || info.CanonicalPolicy != "canonical" || strings.Contains(id, "search") || strings.Contains(id, "auto/") || strings.Contains(id, "router/") {
			continue
		}
		eligible := false
		for _, route := range registry.GetGlobalRegistry().CanonicalRouteInfos(id + ":free") {
			if canonicalCompatible(route, r) {
				eligible = true
				break
			}
		}
		if !eligible {
			continue
		}
		rank, explicit := ranks[id]
		if explicit {
			rank += 0
		} else if canonicalFamily(id) == family {
			rank = 100
		} else {
			continue
		}
		all = append(all, candidate{id, rank})
	}
	sort.Slice(all, func(i, j int) bool {
		if all[i].rank != all[j].rank {
			return all[i].rank < all[j].rank
		}
		return all[i].id > all[j].id
	})
	ids := []string{}
	for _, v := range all {
		ids = append(ids, v.id)
		if len(ids) >= p.FallbackLimit() {
			break
		}
	}
	return ids
}
func (h *BaseAPIHandler) canonicalPlan(ctx context.Context, model string, raw []byte, opts modelExecutionOptions, crossModel bool) (canonicalPlan, bool, *interfaces.ErrorMessage) {
	if h.AuthManager == nil || !h.AuthManager.CanonicalRoutingEnabled() {
		return canonicalPlan{}, false, nil
	}
	base, suffix, free, ok := canonicalInput(model)
	explicitOverride := false
	if info := registry.GetGlobalRegistry().GetModelInfo(thinking.ParseSuffix(model).ModelName, ""); info != nil {
		explicitOverride = info.CanonicalOverride && info.CanonicalPolicy == "override"
	}
	if !ok && strings.HasSuffix(thinking.ParseSuffix(model).ModelName, ":free") && !explicitOverride {
		return canonicalPlan{}, true, &interfaces.ErrorMessage{StatusCode: 404, Error: errors.New("unknown or unavailable canonical free model")}
	}
	if !ok || h.AuthManager == nil {
		return canonicalPlan{}, false, nil
	}
	if h.AuthManager.HomeEnabled() {
		return canonicalPlan{}, true, &interfaces.ErrorMessage{StatusCode: 400, Error: errors.New("canonical cost policy unavailable in Home mode; use a provider override")}
	}
	r, err := canonicalRequestRequirements(raw)
	if err != nil {
		return canonicalPlan{}, true, &interfaces.ErrorMessage{StatusCode: 400, Error: errors.New("invalid JSON request")}
	}
	if suffix != "" {
		r.Reasoning = true
	}
	policy := h.AuthManager.CanonicalRoutingPolicy()
	p := canonicalPlan{Requested: model, Base: base, Suffix: suffix, Policy: "free-then-paid", Limit: policy.AttemptLimit(), Requirements: r}
	p.Stages = []canonicalStage{{base + ":free", 0, false}, {base + ":free", 1, false}}
	if free {
		p.Policy = "free-only"
		var alternatives []string
		if crossModel {
			alternatives = canonicalRankedFallbacks(base, r, policy)
		}
		for _, alt := range alternatives {
			p.Stages = append(p.Stages, canonicalStage{alt + ":free", 0, true}, canonicalStage{alt + ":free", 1, true})
		}
	} else {
		p.Stages = append(p.Stages, canonicalStage{base + ":paid", 2, false}, canonicalStage{base + ":paid", 3, false})
	}
	return p, true, nil
}
func canonicalPreferred(info *registry.ModelInfo) bool {
	return strings.EqualFold(info.OwnedBy, "kilo") || strings.EqualFold(info.OwnedBy, "openrouter")
}
func canonicalPair(auth string, info *registry.ModelInfo) string {
	source := info.MetadataModelID
	if source == "" {
		source = info.CanonicalSourceID
	}
	if source == "" {
		source = info.ID
	}
	return auth + "\x00" + source
}
func canonicalExclusions(stage canonicalStage, r canonicalRequirements, tried map[string]bool, quota map[string]bool) []string {
	excluded := []string{}
	for auth, info := range registry.GetGlobalRegistry().CanonicalRouteInfos(stage.Model) {
		skip := tried[canonicalPair(auth, info)] || (strings.HasSuffix(stage.Model, ":free") && quota[auth])
		preferred := canonicalPreferred(info)
		if stage.Tier == 0 && !preferred || stage.Tier == 1 && preferred || stage.Tier == 2 && strings.EqualFold(info.OwnedBy, "openrouter") || stage.Tier == 3 && !strings.EqualFold(info.OwnedBy, "openrouter") {
			skip = true
		}
		if stage.Alternative && !canonicalCompatible(info, r) {
			skip = true
		}
		if skip {
			excluded = append(excluded, auth)
		}
	}
	return excluded
}
func canonicalCanContinue(err *interfaces.ErrorMessage, selected string) bool {
	if err == nil {
		return false
	}
	if selected == "" {
		return err.StatusCode >= 500 || err.StatusCode == 404 || err.StatusCode == 429
	}
	return err.StatusCode == 429 || err.StatusCode == 503 || err.StatusCode == 404
}
func canonicalBody(raw []byte, model string) []byte {
	var v map[string]json.RawMessage
	if json.Unmarshal(raw, &v) != nil {
		return raw
	}
	if _, ok := v["model"]; !ok {
		return raw
	}
	updated, err := sjson.SetBytes(raw, "model", model)
	if err != nil {
		return raw
	}
	return updated
}
func canonicalHeaders(headers http.Header, p canonicalPlan, stage canonicalStage, selected string, count int, bindings map[string]registry.CanonicalDispatchBinding) http.Header {
	if headers == nil {
		headers = http.Header{}
	}
	resolved := strings.TrimSuffix(strings.TrimSuffix(stage.Model, ":free"), ":paid")
	headers.Set("X-Gateway-Requested-Model", p.Requested)
	headers.Set("X-Gateway-Resolved-Model", resolved)
	headers.Set("X-Gateway-Cost-Policy", p.Policy)
	if b, ok := bindings[selected]; ok {
		headers.Set("X-Gateway-Provider", b.Owner)
	}
	log.WithFields(log.Fields{"requested_model": p.Requested, "resolved_model": resolved, "provider": headers.Get("X-Gateway-Provider"), "cost_policy": p.Policy, "attempts": count}).Info("canonical request resolved")
	return headers
}
func canonicalAttemptContextFor(ctx context.Context, stage canonicalStage, r canonicalRequirements, tried, quota map[string]bool, selected *string) (context.Context, map[string]registry.CanonicalDispatchBinding) {
	previous := selectedAuthIDCallbackFromContext(ctx)
	excluded := canonicalExclusions(stage, r, tried, quota)
	blocked := map[string]bool{}
	for _, id := range excluded {
		blocked[id] = true
	}
	bindings := map[string]registry.CanonicalDispatchBinding{}
	for id, info := range registry.GetGlobalRegistry().CanonicalRouteInfos(stage.Model) {
		if !blocked[id] {
			bindings[id] = registry.NewCanonicalDispatchBinding(id, stage.Model, info)
		}
	}
	ctx = context.WithValue(ctx, canonicalAttemptContextKey{}, canonicalAttemptContext{Excluded: excluded, Route: stage.Model, Bindings: bindings, Permit: &registry.CanonicalDispatchPermit{}})
	return WithSelectedAuthIDCallback(ctx, func(id string) {
		*selected = id
		if previous != nil {
			previous(id)
		}
	}), bindings
}
func canonicalRecordAttempt(stage canonicalStage, selected string, bindings map[string]registry.CanonicalDispatchBinding, tried map[string]bool) {
	if b, ok := bindings[selected]; ok {
		tried[selected+"\x00"+b.PairSource] = true
	}
}
func (h *BaseAPIHandler) executeWithAuthManagerFormats(ctx context.Context, entry, exit, model string, raw []byte, alt string, image bool, opts modelExecutionOptions) ([]byte, http.Header, *interfaces.ErrorMessage) {
	if ctx == nil {
		ctx = context.Background()
	}
	p, handled, invalid := h.canonicalPlan(ctx, model, raw, opts, !image && canonicalChatProtocol(entry))
	if invalid != nil {
		return nil, nil, invalid
	}
	if !handled {
		return h.executeCanonicalNonstreamAttempt(ctx, entry, exit, model, raw, alt, image, opts)
	}
	tried := map[string]bool{}
	quota := map[string]bool{}
	count := 0
	var last *interfaces.ErrorMessage
	for _, stage := range p.Stages {
		for count < p.Limit {
			selected := ""
			attemptCtx, bindings := canonicalAttemptContextFor(ctx, stage, p.Requirements, tried, quota, &selected)
			body, headers, err := h.executeCanonicalNonstreamAttempt(attemptCtx, entry, exit, stage.Model+p.Suffix, canonicalBody(raw, stage.Model+p.Suffix), alt, image, opts)
			if selected != "" {
				count++
				canonicalRecordAttempt(stage, selected, bindings, tried)
			}
			if err == nil {
				return body, canonicalHeaders(headers, p, stage, selected, count, bindings), nil
			}
			if selected != "" || last == nil {
				last = err
			}
			if ctx.Err() != nil {
				return nil, headers, err
			}
			if !canonicalCanContinue(err, selected) {
				return nil, headers, err
			}
			if err.StatusCode == 429 && selected != "" {
				quota[selected] = true
			}
			if selected == "" {
				break
			}
		}
		if count >= p.Limit {
			break
		}
	}
	if last == nil {
		last = &interfaces.ErrorMessage{StatusCode: 503, Error: errors.New("no compatible eligible canonical route")}
	}
	return nil, nil, last
}
func (h *BaseAPIHandler) executeStreamWithAuthManagerFormats(ctx context.Context, entry, exit, model string, raw []byte, alt string, image bool, opts modelExecutionOptions) (<-chan []byte, http.Header, <-chan *interfaces.ErrorMessage) {
	if ctx == nil {
		ctx = context.Background()
	}
	p, handled, invalid := h.canonicalPlan(ctx, model, raw, opts, !image && canonicalChatProtocol(entry))
	if !handled && invalid == nil {
		return h.executeCanonicalStreamAttempt(ctx, entry, exit, model, raw, alt, image, opts)
	}
	fail := func(e *interfaces.ErrorMessage) (<-chan []byte, http.Header, <-chan *interfaces.ErrorMessage) {
		ch := make(chan *interfaces.ErrorMessage, 1)
		ch <- e
		close(ch)
		return nil, nil, ch
	}
	if invalid != nil {
		return fail(invalid)
	}
	tried := map[string]bool{}
	quota := map[string]bool{}
	count := 0
	var last *interfaces.ErrorMessage
	for _, stage := range p.Stages {
		for count < p.Limit {
			selected := ""
			attemptCtx, cancel := context.WithCancel(ctx)
			attemptCtx, bindings := canonicalAttemptContextFor(attemptCtx, stage, p.Requirements, tried, quota, &selected)
			data, headers, errs := h.executeCanonicalStreamAttempt(attemptCtx, entry, exit, stage.Model+p.Suffix, canonicalBody(raw, stage.Model+p.Suffix), alt, image, opts)
			if selected != "" {
				count++
				canonicalRecordAttempt(stage, selected, bindings, tried)
			}
			var first []byte
			var open bool
			if data != nil {
				select {
				case first, open = <-data:
				case <-ctx.Done():
					cancel()
					return fail(&interfaces.ErrorMessage{StatusCode: 499, Error: ctx.Err()})
				}
			}
			if open {
				out := make(chan []byte)
				headers = canonicalHeaders(headers, p, stage, selected, count, bindings)
				go func() {
					defer close(out)
					defer cancel()
					select {
					case out <- first:
					case <-ctx.Done():
						return
					}
					for chunk := range data {
						select {
						case out <- chunk:
						case <-ctx.Done():
							return
						}
					}
				}()
				return out, headers, errs // Once a byte is committed, no model/provider fallback.
			}
			var err *interfaces.ErrorMessage
			if errs != nil {
				select {
				case err = <-errs:
				case <-ctx.Done():
					cancel()
					return fail(&interfaces.ErrorMessage{StatusCode: 499, Error: ctx.Err()})
				}
			}
			cancel()
			if err == nil {
				err = &interfaces.ErrorMessage{StatusCode: 502, Error: errors.New("upstream stream ended without output")}
			}
			if selected != "" || last == nil {
				last = err
			}
			if ctx.Err() != nil || !canonicalCanContinue(err, selected) {
				return fail(err)
			}
			if err.StatusCode == 429 && selected != "" {
				quota[selected] = true
			}
			if selected == "" {
				break
			}
		}
		if count >= p.Limit {
			break
		}
	}
	if last == nil {
		last = &interfaces.ErrorMessage{StatusCode: 503, Error: errors.New("no compatible eligible canonical route")}
	}
	return fail(last)
}

func canonicalChatProtocol(entry string) bool {
	switch entry {
	case "openai", "claude", "openai-response", "gemini":
		return true
	}
	return false
}
