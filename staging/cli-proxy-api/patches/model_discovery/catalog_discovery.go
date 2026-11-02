package cliproxy

// Opt-in metadata-only discovery for native compatible providers. The service
// owns the lifetime; no external synchronizer, copied keys or OAuth owner.
import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"net/url"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/router-for-me/CLIProxyAPI/v8/internal/runtime/executor/helps"
	coreauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/config"
	log "github.com/sirupsen/logrus"
)

type catalogRefreshContextKey struct{}
type discoverySnapshot struct {
	models  []*ModelInfo
	seen    map[string]bool
	details map[string]*ModelInfo
}
type catalogDiscoveryState struct {
	mu        sync.RWMutex
	snapshots map[string]discoverySnapshot
	next      map[string]time.Time
}

func discoveryKey(p *config.OpenAICompatibility) string {
	raw, _ := json.Marshal(p)
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}
func discoveryEnabled(p *config.OpenAICompatibility) bool {
	return p != nil && !p.Disabled && p.ModelDiscovery != nil && p.ModelDiscovery.Enabled
}
func discoveryPeriod(p *config.OpenAICompatibility) time.Duration {
	seconds := p.ModelDiscovery.RefreshSeconds
	if seconds < 60 {
		seconds = 900
	}
	return time.Duration(seconds) * time.Second
}
func (s *Service) discoveredCompatModels(p *config.OpenAICompatibility, manual []*ModelInfo) []*ModelInfo {
	if !discoveryEnabled(p) {
		return manual
	}
	s.catalogDiscovery.mu.RLock()
	snapshot, ok := s.catalogDiscovery.snapshots[discoveryKey(p)]
	s.catalogDiscovery.mu.RUnlock()
	if !ok {
		return manual
	}
	byID := snapshot.details
	mapped := map[string]bool{}
	out := make([]*ModelInfo, 0, len(manual)+len(snapshot.models))
	for _, m := range manual {
		if m == nil {
			continue
		}
		clone := *m
		upstream := m.MetadataModelID
		if upstream == "" {
			upstream = m.ID
		}
		mapped[upstream] = true
		if source := byID[upstream]; source != nil {
			// Operator overrides remain authoritative; do not retain synthetic template
			// controls when the actual catalog supplies no such control declaration.
			if clone.MaxContextLength <= 0 {
				clone.ContextLength = source.ContextLength
			}
			clone.MaxCompletionTokens = source.MaxCompletionTokens
			clone.InputTokenLimit = source.InputTokenLimit
			clone.OutputTokenLimit = source.OutputTokenLimit
			clone.SupportedParameters = source.SupportedParameters
			clone.SupportedGenerationMethods = source.SupportedGenerationMethods
			if !clone.ExplicitInputModalities {
				clone.SupportedInputModalities = source.SupportedInputModalities
			}
			if len(source.SupportedOutputModalities) > 0 {
				clone.SupportedOutputModalities = source.SupportedOutputModalities
			}
			if !clone.ExplicitThinking {
				clone.Thinking = source.Thinking
			}
		}
		out = append(out, &clone)
	}
	for _, m := range snapshot.models {
		if !mapped[m.ID] {
			out = append(out, m)
		}
	}
	return out
}
func (s *Service) discoveredCompatModelsForAuth(cfg *config.Config, auth *coreauth.Auth, name string, models []*ModelInfo) []*ModelInfo {
	p := configEntryForAuthIndex(auth, cfg.OpenAICompatibility)
	if p == nil {
		for i := range cfg.OpenAICompatibility {
			if strings.EqualFold(cfg.OpenAICompatibility[i].Name, name) {
				p = &cfg.OpenAICompatibility[i]
				break
			}
		}
	}
	return s.discoveredCompatModels(p, models)
}

// runCatalogDiscovery does not execute prompts, refresh tokens or change config.
// The immediate first pass discovers catalogs, then unchanged catalogs are cheap
// no-ops. Failure retains the last good snapshot; it never admits unknown prices.
func (s *Service) runCatalogDiscovery(ctx context.Context) {
	s.catalogDiscoveryPass(ctx, time.Now())
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-ticker.C:
			s.catalogDiscoveryPass(ctx, now)
		}
	}
}
func (s *Service) catalogDiscoveryPass(ctx context.Context, now time.Time) {
	if ctx.Err() != nil || s.coreManager == nil {
		return
	}
	cfg := s.currentConfig()
	if cfg == nil {
		return
	}
	s.catalogDiscovery.mu.Lock()
	if s.catalogDiscovery.next == nil {
		s.catalogDiscovery.next = map[string]time.Time{}
	}
	active := map[string]bool{"plugins": true}
	for i := range cfg.OpenAICompatibility {
		if discoveryEnabled(&cfg.OpenAICompatibility[i]) {
			active[discoveryKey(&cfg.OpenAICompatibility[i])] = true
		}
	}
	for key := range s.catalogDiscovery.snapshots {
		if !active[key] {
			delete(s.catalogDiscovery.snapshots, key)
			delete(s.catalogDiscovery.next, key)
		}
	}
	s.catalogDiscovery.mu.Unlock()
	auths := s.coreManager.List()
	for i := range cfg.OpenAICompatibility {
		p := &cfg.OpenAICompatibility[i]
		if !discoveryEnabled(p) {
			continue
		}
		key := discoveryKey(p)
		s.catalogDiscovery.mu.Lock()
		if s.catalogDiscovery.next == nil {
			s.catalogDiscovery.next = map[string]time.Time{}
		}
		due := s.catalogDiscovery.next[key]
		if now.Before(due) {
			s.catalogDiscovery.mu.Unlock()
			continue
		}
		s.catalogDiscovery.next[key] = now.Add(discoveryPeriod(p))
		s.catalogDiscovery.mu.Unlock()
		var candidates []*coreauth.Auth
		for _, a := range auths {
			if a == nil || a.Disabled || a.Status == coreauth.StatusDisabled || a.AuthKind() != coreauth.AuthKindAPIKey {
				continue
			}
			if raw, ok := a.Attributes["weight"]; ok {
				if weight, err := strconv.Atoi(raw); err == nil && weight <= 0 {
					continue
				}
			}
			_, name, ok := openAICompatInfoFromAuth(a)
			if ok && strings.EqualFold(name, p.Name) {
				candidates = append(candidates, a)
			}
		}
		sort.Slice(candidates, func(i, j int) bool { return candidates[i].ID < candidates[j].ID })
		if len(candidates) == 0 {
			continue
		}
		snapshot, err := fetchDiscoveryCatalog(ctx, cfg, p, candidates[0])
		if err != nil {
			log.WithField("provider", p.Name).Warn("model catalog refresh failed; retained last good catalog")
			continue
		}
		// A configuration changed while the GET was in flight: discard stale data.
		if s.currentConfig() != cfg {
			continue
		}
		s.catalogDiscovery.mu.Lock()
		if s.catalogDiscovery.snapshots == nil {
			s.catalogDiscovery.snapshots = map[string]discoverySnapshot{}
		}
		previous, had := s.catalogDiscovery.snapshots[key]
		changed := !had || !reflect.DeepEqual(previous, snapshot)
		s.catalogDiscovery.snapshots[key] = snapshot
		s.catalogDiscovery.mu.Unlock()
		if changed {
			for _, a := range candidates {
				s.refreshModelRegistrationForAuthWithContext(context.WithValue(ctx, catalogRefreshContextKey{}, true), a, nil)
			}
			log.WithFields(log.Fields{"provider": p.Name, "free_catalog_models": len(snapshot.models)}).Info("model catalog refreshed")
		}
	}
	// Plugin model callbacks already implement their provider-specific catalogs.
	// Refresh only the explicitly configured providers, never quarantined OpenCode.
	if cfg.Plugins.Enabled && cfg.Plugins.ModelRefreshSeconds > 0 {
		key := "plugins"
		period := time.Duration(cfg.Plugins.ModelRefreshSeconds) * time.Second
		if period < time.Minute {
			period = 15 * time.Minute
		}
		s.catalogDiscovery.mu.Lock()
		due := s.catalogDiscovery.next[key]
		if !now.Before(due) {
			s.catalogDiscovery.next[key] = now.Add(period)
		}
		s.catalogDiscovery.mu.Unlock()
		if !now.Before(due) {
			for _, a := range auths {
				if a == nil || a.Disabled || a.Status == coreauth.StatusDisabled || strings.EqualFold(a.Provider, "opencode") {
					continue
				}
				for _, provider := range cfg.Plugins.ModelRefreshProviders {
					if strings.EqualFold(a.Provider, provider) {
						s.refreshModelRegistrationForAuthWithContext(context.WithValue(ctx, catalogRefreshContextKey{}, true), a, nil)
						break
					}
				}
			}
		}
	}
}

var discoveryHTTPClient = helps.NewProxyAwareHTTPClient

func fetchDiscoveryCatalog(ctx context.Context, cfg *config.Config, p *config.OpenAICompatibility, a *coreauth.Auth) (discoverySnapshot, error) {
	u, err := url.Parse(p.BaseURL)
	if err != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil {
		return discoverySnapshot{}, fmt.Errorf("invalid discovery endpoint")
	}
	u.Path = strings.TrimRight(u.Path, "/") + "/models"
	u.RawQuery = ""
	u.Fragment = ""
	requestCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(requestCtx, http.MethodGet, u.String(), nil)
	if err != nil {
		return discoverySnapshot{}, err
	}
	req.Header.Set("Accept", "application/json")
	// The existing runtime auth object owns the key/proxy. No copy is persisted.
	if value := a.Attributes["api_key"]; value != "" {
		req.Header.Set("Authorization", "Bearer "+value)
	}
	for k, v := range p.Headers {
		req.Header.Set(k, v)
	}
	client := discoveryHTTPClient(requestCtx, cfg, a, 20*time.Second)
	clone := *client
	clone.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	resp, err := clone.Do(req)
	if err != nil {
		return discoverySnapshot{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return discoverySnapshot{}, fmt.Errorf("catalog HTTP status %d", resp.StatusCode)
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 16*1024*1024+1))
	if err != nil || len(raw) > 16*1024*1024 {
		return discoverySnapshot{}, fmt.Errorf("catalog body invalid")
	}
	return parseDiscoveryCatalog(raw, p.Name, u.Hostname(), p.ModelDiscovery.FreeOnly)
}
func zeroCatalogValue(v any) bool {
	var value string
	switch x := v.(type) {
	case string:
		value = x
	case json.Number:
		value = x.String()
	default:
		return false
	}
	n, ok := new(big.Rat).SetString(value)
	return ok && n.Sign() == 0
}
func freeCatalogEntry(row map[string]any, host string) bool {
	if raw, ok := row["pricing"]; ok {
		switch p := raw.(type) {
		case map[string]any:
			if v, exists := p["request"]; exists {
				return zeroCatalogValue(v) && zeroOrAbsent(p, "prompt") && zeroOrAbsent(p, "completion")
			}
			if _, exists := p["input"]; exists {
				return zeroCatalogValue(p["input"]) && zeroCatalogValue(p["output"])
			}
			return zeroCatalogValue(p["prompt"]) && zeroCatalogValue(p["completion"])
		case []any:
			if len(p) == 0 {
				return false
			}
			for _, band := range p {
				b, ok := band.(map[string]any)
				if !ok || !zeroCatalogValue(b["input_price"]) || !zeroCatalogValue(b["output_price"]) {
					return false
				}
			}
			return true
		default:
			return false
		}
	}
	if _, has := row["input_price"]; has {
		return zeroCatalogValue(row["input_price"]) && zeroCatalogValue(row["output_price"])
	}
	id, _ := row["id"].(string)
	if host == "api.orcarouter.ai" && id == "orcarouter/free" {
		return true
	}
	return (host == "api.unorouter.com" || host == "unorouter.com" || host == "openrouter.ai") && (strings.HasSuffix(id, ":free") || id == "openrouter/free")
}
func zeroOrAbsent(p map[string]any, key string) bool {
	v, exists := p[key]
	return !exists || zeroCatalogValue(v)
}
func catalogInt(row map[string]any, keys ...string) int {
	for _, key := range keys {
		if n, ok := row[key].(json.Number); ok {
			v, err := n.Int64()
			if err == nil && v > 0 && v <= 100000000 {
				return int(v)
			}
		}
	}
	return 0
}
func catalogList(row map[string]any, key string) []string {
	raw, _ := row[key].([]any)
	out := []string{}
	for _, v := range raw {
		if s, ok := v.(string); ok && s != "" {
			out = append(out, s)
		}
	}
	return out
}
func parseDiscoveryCatalog(raw []byte, owner, host string, freeOnly bool) (discoverySnapshot, error) {
	var root struct {
		Data []map[string]any `json:"data"`
	}
	decoder := json.NewDecoder(strings.NewReader(string(raw)))
	decoder.UseNumber()
	if err := decoder.Decode(&root); err != nil || root.Data == nil || len(root.Data) > 10000 {
		return discoverySnapshot{}, fmt.Errorf("invalid model catalog")
	}
	var trailing any
	if decoder.Decode(&trailing) != io.EOF {
		return discoverySnapshot{}, fmt.Errorf("trailing catalog data")
	}
	out := discoverySnapshot{seen: map[string]bool{}, details: map[string]*ModelInfo{}}
	for _, row := range root.Data {
		id, _ := row["id"].(string)
		id = strings.TrimSpace(id)
		if id == "" || len(id) > 512 || out.seen[id] {
			continue
		}
		out.seen[id] = true
		admit := !freeOnly || freeCatalogEntry(row, host)
		name, _ := row["name"].(string)
		if name == "" {
			name = id
		}
		description, _ := row["description"].(string)
		m := &ModelInfo{ID: id, MetadataModelID: id, Object: "model", OwnedBy: owner, Type: "model", Name: id, DisplayName: name, Description: description, ContextLength: catalogInt(row, "context_length", "context_window"), MaxCompletionTokens: catalogInt(row, "max_output_tokens", "max_completion_tokens"), SupportedParameters: catalogList(row, "supported_parameters"), SupportedInputModalities: catalogList(row, "input_modalities"), SupportedOutputModalities: catalogList(row, "output_modalities"), SupportedGenerationMethods: []string{"generateContent"}}
		if architecture, ok := row["architecture"].(map[string]any); ok {
			if len(m.SupportedInputModalities) == 0 {
				m.SupportedInputModalities = catalogList(architecture, "input_modalities")
			}
			if len(m.SupportedOutputModalities) == 0 {
				m.SupportedOutputModalities = catalogList(architecture, "output_modalities")
			}
		}
		if b, ok := row["supports_tool_calling"].(bool); ok && b && len(m.SupportedParameters) == 0 {
			m.SupportedParameters = []string{"tools", "tool_choice"}
		}
		if b, ok := row["supports_vision"].(bool); ok && b && len(m.SupportedInputModalities) == 0 {
			m.SupportedInputModalities = []string{"text", "image"}
		}
		m.InputTokenLimit = m.ContextLength
		m.OutputTokenLimit = m.MaxCompletionTokens
		out.details[id] = m
		if admit {
			out.models = append(out.models, m)
		}
	}
	sort.Slice(out.models, func(i, j int) bool { return out.models[i].ID < out.models[j].ID })
	return out, nil
}
