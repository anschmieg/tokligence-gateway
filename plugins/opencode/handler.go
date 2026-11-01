package opencode

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// Native source pins for this file (see SOURCE-PINS.md):
//   - device login flow: packages/core/src/plugin/provider/opencode.ts
//     (oauth(): POST /auth/device/code, poll /auth/device/token,
//     GET /api/user + /api/orgs)
//   - refresh: same file, refresh(): POST /auth/device/token with
//     grant_type=refresh_token; 400 invalid_grant is terminal SignedOut
//   - expiry admission: packages/core/src/integration.ts expiring():
//     refresh when expires <= now + 5min
//
// Login (auth.login.start/poll) is NOT implemented: a login here would create
// a second refresh owner against the account, and the audited work requires
// single sequential refresh ownership. The host surfaces an explicit 501 and
// the operator seeds the auth-dir credential from the existing owner.
//
// Refresh IS implemented per the reviewed plan: the host's own auto-refresh
// loop is the single sequential owner (it calls auth.refresh on schedule;
// this plugin performs the grant rotation on its behalf through the host
// HTTP transport and returns the rotated credential). Writing the refresh
// implementation does not itself activate a token owner: the credential's
// live owner changes only by the separate staged handoff.

// PluginMetadata is returned on plugin.register / plugin.reconfigure.
type PluginMetadata struct {
	Name             string `json:"Name"`
	Version          string `json:"Version"`
	Author           string `json:"Author"`
	GitHubRepository string `json:"GitHubRepository"`
	ConfigFields     []any  `json:"ConfigFields"`
}

// RegistrationResponse is the plugin.register envelope result.
type RegistrationResponse struct {
	SchemaVersion uint32                   `json:"schema_version"`
	Metadata      PluginMetadata           `json:"metadata"`
	Capabilities  RegistrationCapabilities `json:"capabilities"`
}

// RegistrationCapabilities declares auth_provider, model_registrar,
// model_provider and executor with OAuth model scope.
type RegistrationCapabilities struct {
	AuthProvider          bool     `json:"auth_provider"`
	ModelRegistrar        bool     `json:"model_registrar"`
	ModelProvider         bool     `json:"model_provider"`
	Executor              bool     `json:"executor"`
	ExecutorModelScope    string   `json:"executor_model_scope"`
	ExecutorInputFormats  []string `json:"executor_input_formats"`
	ExecutorOutputFormats []string `json:"executor_output_formats"`
}

// LifecycleRequest is the plugin.register/reconfigure request payload.
type LifecycleRequest struct {
	ConfigYAML    wireBytes `json:"config_yaml"`
	SchemaVersion uint32    `json:"schema_version"`
}

// HostState carries the host-provided context of the current call.
type HostState struct {
	AuthDir  string `json:"AuthDir"`
	ProxyURL string `json:"ProxyURL"`
}

// AuthParseRequest mirrors pluginapi.AuthParseRequest.
type AuthParseRequest struct {
	Provider string    `json:"Provider"`
	Path     string    `json:"Path"`
	FileName string    `json:"FileName"`
	RawJSON  wireBytes `json:"RawJSON"`
	Host     HostState `json:"Host"`
}

// AuthParseResponse mirrors pluginapi.AuthParseResponse.
type AuthParseResponse struct {
	Handled bool     `json:"Handled"`
	Auth    AuthData `json:"Auth"`
}

// AuthData mirrors pluginapi.AuthData.
type AuthData struct {
	Provider         string            `json:"Provider"`
	ID               string            `json:"ID,omitempty"`
	FileName         string            `json:"FileName,omitempty"`
	Label            string            `json:"Label,omitempty"`
	StorageJSON      []byte            `json:"StorageJSON,omitempty"`
	Metadata         map[string]any    `json:"Metadata,omitempty"`
	Attributes       map[string]string `json:"Attributes,omitempty"`
	NextRefreshAfter time.Time         `json:"NextRefreshAfter,omitempty"`
}

// AuthRefreshRequest mirrors pluginapi.AuthRefreshRequest.
type AuthRefreshRequest struct {
	AuthID         string            `json:"AuthID"`
	AuthProvider   string            `json:"AuthProvider"`
	StorageJSON    wireBytes         `json:"StorageJSON"`
	Metadata       map[string]any    `json:"Metadata"`
	Attributes     map[string]string `json:"Attributes"`
	Host           HostState         `json:"Host"`
	HostCallbackID string            `json:"host_callback_id,omitempty"`
}

// AuthRefreshResponse mirrors pluginapi.AuthRefreshResponse.
type AuthRefreshResponse struct {
	Auth             AuthData  `json:"Auth"`
	NextRefreshAfter time.Time `json:"NextRefreshAfter"`
}

// AuthModelRequest mirrors pluginapi.AuthModelRequest.
type AuthModelRequest struct {
	AuthID       string            `json:"AuthID"`
	AuthProvider string            `json:"AuthProvider"`
	StorageJSON  wireBytes         `json:"StorageJSON"`
	Metadata     map[string]any    `json:"Metadata"`
	Attributes   map[string]string `json:"Attributes"`
}

// ExecutorRequest mirrors pluginapi.ExecutorRequest.
type ExecutorRequest struct {
	AuthID          string              `json:"AuthID"`
	AuthProvider    string              `json:"AuthProvider"`
	Model           string              `json:"Model"`
	Stream          bool                `json:"Stream"`
	Headers         map[string][]string `json:"Headers"`
	OriginalRequest wireBytes           `json:"OriginalRequest"`
	SourceFormat    string              `json:"SourceFormat"`
	Payload         wireBytes           `json:"Payload"`
	Metadata        map[string]any      `json:"Metadata"`
	StorageJSON     wireBytes           `json:"StorageJSON"`
	AuthMetadata    map[string]any      `json:"AuthMetadata"`
	AuthAttributes  map[string]string   `json:"AuthAttributes"`
	StreamID        string              `json:"stream_id,omitempty"`
	HostCallbackID  string              `json:"host_callback_id,omitempty"`
}

// ExecutorResponse mirrors pluginapi.ExecutorResponse.
type ExecutorResponse struct {
	Payload []byte              `json:"Payload"`
	Headers map[string][]string `json:"Headers,omitempty"`
}

// NowMs returns the current epoch milliseconds (injectable for tests).
type NowMs func() int64

// Handler dispatches plugin RPC methods. Transport is injected so tests
// drive refresh and dispatch with fakes and no network.
type Handler struct {
	mu            sync.RWMutex
	activeStreams atomic.Int64
	transport     Transport
	nowMs         NowMs
	cfg           PluginConfig
	catalog       []RegisteredModel
	registry      *SessionRegistry
}

// NewHandler builds a handler with the given transport and clock. The
// registry starts in-memory; AttachRegistry upgrades it to persistent
// before serving traffic.
func NewHandler(transport Transport, nowMs NowMs) *Handler {
	if nowMs == nil {
		nowMs = func() int64 { return time.Now().UnixMilli() }
	}
	registry, _ := NewSessionRegistry(RegistryOptions{NowMs: nowMs})
	return &Handler{transport: transport, nowMs: nowMs, registry: registry}
}

// AttachRegistry replaces the handler's registry with a persistent one.
// Called by the cgo entry point after the config supplies the state path.
func (h *Handler) AttachRegistry(registry *SessionRegistry) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.activeStreams.Load() != 0 {
		return withStatus(409, fmt.Errorf("opencode streams are active"))
	}
	if registry != nil && registry != h.registry {
		old := h.registry
		h.registry = registry
		if old != nil {
			old.Close()
		}
	}
	return nil
}

// Configure applies the plugin configuration subtree. A configured
// session_state_path upgrades the registry to persistent form.
func (h *Handler) Configure(raw []byte) error {
	cfg, err := DecodeConfig(raw)
	if err != nil {
		return err
	}
	if cfg.InferenceBaseURL != "" {
		if _, err := InferenceEndpoint(cfg.InferenceBaseURL); err != nil {
			return err
		}
	}
	if path := cfg.registryStatePath(); path != "" {
		cfg.SessionStatePath, err = filepath.Abs(path)
		if err != nil {
			return err
		}
	}
	var catalog []RegisteredModel
	if len(cfg.Models) > 0 {
		catalog, err = BuildModelCatalog(cfg)
		if err != nil {
			return err
		}
	}
	// A write never waits behind a long dispatch or swaps out a live pump.
	if !h.mu.TryLock() {
		return withStatus(409, fmt.Errorf("opencode requests are active; retry configuration when idle"))
	}
	defer h.mu.Unlock()
	if h.activeStreams.Load() != 0 {
		return withStatus(409, fmt.Errorf("opencode streams are active; retry configuration when idle"))
	}
	registry := h.registry
	if registry == nil || registry.path != cfg.registryStatePath() {
		registry, err = NewSessionRegistry(RegistryOptions{Path: cfg.registryStatePath(), NowMs: h.nowMs})
		if err != nil {
			return err
		}
	}
	old := h.registry
	h.cfg, h.catalog, h.registry = cfg, catalog, registry
	if old != nil && old != registry {
		old.Close()
	}
	return nil
}

// Registration builds the plugin.register response for the given schema.
func (h *Handler) Registration(schemaVersion uint32) RegistrationResponse {
	return RegistrationResponse{
		SchemaVersion: schemaVersion,
		Metadata: PluginMetadata{
			Name:             "tokligence-opencode",
			Version:          "0.2.0",
			Author:           "tokligence",
			GitHubRepository: "https://github.com/tokligence/tokligence",
			ConfigFields:     []any{},
		},
		Capabilities: RegistrationCapabilities{
			AuthProvider:          true,
			ModelRegistrar:        true,
			ModelProvider:         true,
			Executor:              true,
			ExecutorModelScope:    "oauth",
			ExecutorInputFormats:  []string{"openai"},
			ExecutorOutputFormats: []string{"openai"},
		},
	}
}

// HandleMethod dispatches one plugin RPC method. It returns the
// envelope-ready result payload. An error carries an HTTP status when known.
func (h *Handler) HandleMethod(method string, request []byte) ([]byte, error) {
	if method != "plugin.register" && method != "plugin.reconfigure" {
		h.mu.RLock()
		defer h.mu.RUnlock()
	}
	switch method {
	case "plugin.register", "plugin.reconfigure":
		var req LifecycleRequest
		if err := decodeInto(request, &req); err != nil {
			return nil, err
		}
		if err := h.Configure(req.ConfigYAML.bytes()); err != nil {
			return nil, err
		}
		return okEnvelope(h.Registration(req.SchemaVersion))
	case "auth.identifier":
		return okEnvelope(map[string]string{"identifier": ProviderKey})
	case "auth.parse":
		return h.handleAuthParse(request)
	case "auth.refresh":
		return h.handleAuthRefresh(request)
	case "auth.login.start":
		return nil, withStatus(501, fmt.Errorf("opencode device login is not implemented in this slice; seed the auth-dir credential from its existing single owner instead of creating a second refresh owner"))
	case "auth.login.poll":
		return nil, withStatus(501, fmt.Errorf("opencode device login polling is not implemented in this slice"))
	case "model.register", "model.static":
		return h.handleModelStatic()
	case "model.for_auth":
		return h.handleModelForAuth(request)
	case "executor.identifier":
		return okEnvelope(map[string]string{"identifier": ProviderKey})
	case "executor.execute":
		return h.handleExecute(request, false)
	case "executor.execute_stream":
		return h.handleExecute(request, true)
	case "executor.count_tokens":
		return nil, withStatus(501, fmt.Errorf("opencode token counting is not implemented in this slice; no fabricated counts"))
	case "executor.http_request":
		return h.handleExecutorHTTPRequest(request)
	case "session.stats":
		return h.handleSessionStats()
	default:
		return nil, fmt.Errorf("unknown method: %s", method)
	}
}

// handleAuthParse recognizes the native OpenCode OAuth credential shape in
// the auth-dir file. Foreign payloads are declined (Handled: false) so other
// parsers can run.
func (h *Handler) handleAuthParse(request []byte) ([]byte, error) {
	var req AuthParseRequest
	if err := decodeInto(request, &req); err != nil {
		return nil, err
	}
	if req.Provider != "" && req.Provider != ProviderKey {
		return okEnvelope(AuthParseResponse{Handled: false})
	}
	credential, err := ParseCredential(req.RawJSON.bytes())
	if err != nil {
		return okEnvelope(AuthParseResponse{Handled: false})
	}
	fileName := strings.TrimSpace(req.FileName)
	if fileName == "" {
		fileName = ProviderKey + ".json"
	}
	storageJSON, err := marshalJSON(credential)
	if err != nil {
		return nil, err
	}
	next := credential.NextRefreshAfter(h.nowMs(), DefaultRefreshBufferMs)
	return okEnvelope(AuthParseResponse{
		Handled: true,
		Auth: AuthData{
			Provider:         ProviderKey,
			ID:               ProviderKey + ":" + fileName,
			FileName:         fileName,
			Label:            "OpenCode Console",
			StorageJSON:      storageJSON,
			Metadata:         map[string]any{"type": ProviderKey},
			Attributes:       map[string]string{"type": ProviderKey},
			NextRefreshAfter: time.UnixMilli(next),
		},
	})
}

// handleAuthRefresh performs the native refresh grant on behalf of the
// host's single sequential refresh owner. It ports opencode.ts refresh():
// POST {server}/auth/device/token with grant_type=refresh_token,
// refresh_token and client_id=opencode-cli (form-encoded, as the native
// send() posts a JSON body of string/boolean records — the native post()
// uses schemaBodyJson, so the body is JSON, not form encoding).
func (h *Handler) handleAuthRefresh(request []byte) ([]byte, error) {
	var req AuthRefreshRequest
	if err := decodeInto(request, &req); err != nil {
		return nil, err
	}
	if req.AuthProvider != "" && req.AuthProvider != ProviderKey {
		return nil, withStatus(400, fmt.Errorf("opencode cannot refresh another provider's credential"))
	}
	credential, err := ParseCredential(req.StorageJSON.bytes())
	if err != nil {
		return nil, withStatus(500, fmt.Errorf("opencode refresh rejected: %v", err))
	}
	if h.transport == nil {
		return nil, withStatus(500, fmt.Errorf("opencode refresh has no host transport"))
	}
	server := credential.Server()
	if _, err := secureEndpoint(server); err != nil {
		return nil, withStatus(400, err)
	}
	body, err := marshalJSON(map[string]string{
		"grant_type":    "refresh_token",
		"refresh_token": credential.Refresh,
		"client_id":     ClientID,
	})
	if err != nil {
		return nil, err
	}
	headers := map[string][]string{
		"content-type": {"application/json"},
		"accept":       {"application/json"},
		"user-agent":   {UserAgent(h.cfg.App())},
	}
	result, err := h.transport.Do(WithHostCallbackID(context.Background(), req.HostCallbackID), "POST", server+"/auth/device/token", headers, body)
	if err != nil {
		return nil, withStatus(502, fmt.Errorf("opencode refresh transport failed: %v", err))
	}
	if result.StatusCode == 400 {
		if strings.Contains(strings.ToLower(string(result.Body)), "invalid_grant") {
			// Native SignedOut: the session or refresh token was revoked or
			// expired; only a new device login recovers. Never retry.
			return nil, withStatus(401, &SignedOutError{Detail: "the Console returned invalid_grant"})
		}
		return nil, withStatus(400, fmt.Errorf("opencode refresh failed: HTTP 400"))
	}
	if result.StatusCode < 200 || result.StatusCode >= 300 {
		code := "opencode_refresh_failed"
		if result.StatusCode == 401 || result.StatusCode == 403 {
			code = "opencode_signed_out"
		}
		return nil, &statusError{
			status: result.StatusCode,
			code:   fmt.Sprintf("%s: HTTP %d", code, result.StatusCode),
		}
	}
	rotated, err := RefreshTokenResponse(result.Body, credential, h.nowMs())
	if err != nil {
		return nil, withStatus(502, err)
	}
	storageJSON, err := marshalJSON(rotated)
	if err != nil {
		return nil, err
	}
	next := rotated.NextRefreshAfter(h.nowMs(), DefaultRefreshBufferMs)
	return okEnvelope(AuthRefreshResponse{
		Auth: AuthData{
			Provider:         ProviderKey,
			ID:               req.AuthID,
			Metadata:         req.Metadata,
			Attributes:       req.Attributes,
			StorageJSON:      storageJSON,
			NextRefreshAfter: time.UnixMilli(next),
		},
		NextRefreshAfter: time.UnixMilli(next),
	})
}

// handleModelStatic publishes the configured allowlist as the static
// catalog. The executor model scope is oauth, so the host only binds these
// models to matching credentials.
func (h *Handler) handleModelStatic() ([]byte, error) {
	if h.catalog == nil {
		return okEnvelope(PluginModels{Provider: ProviderKey})
	}
	return okEnvelope(PluginModels{Provider: ProviderKey, Models: h.catalog})
}

// handleModelForAuth publishes the per-credential catalog. A credential that
// cannot be parsed fails closed: no models are published for it.
func (h *Handler) handleModelForAuth(request []byte) ([]byte, error) {
	var req AuthModelRequest
	if err := decodeInto(request, &req); err != nil {
		return nil, err
	}
	if req.AuthProvider != "" && req.AuthProvider != ProviderKey {
		return nil, withStatus(400, fmt.Errorf("opencode cannot publish models for another provider"))
	}
	if _, err := ParseCredential(req.StorageJSON.bytes()); err != nil {
		return nil, withStatus(401, fmt.Errorf("opencode credential is unusable: %v", err))
	}
	if h.catalog == nil {
		return okEnvelope(PluginModels{Provider: ProviderKey})
	}
	return okEnvelope(PluginModels{Provider: ProviderKey, Models: h.catalog})
}

// sessionIDFromHeaders reads a caller-supplied OpenCode session identity
// from the request headers the host forwards. Only the exact native shape is
// accepted; the host's affinity/session headers may carry other namespaces.
func sessionIDFromHeaders(headers map[string][]string) (sessionID string) {
	for _, name := range []string{"x-opencode-session-id", "x-session-affinity", "x-opencode-session"} {
		for _, value := range headers[name] {
			trimmed := strings.TrimSpace(value)
			if ValidSessionID(trimmed) {
				return trimmed
			}
		}
	}
	return ""
}

// sessionIDFromMetadata reads a caller-supplied native session id from the
// host metadata. Only an exact native shape (optionally as the suffix after
// the last ':' in a host namespace) is returned; foreign identities yield ""
// so the registry path resolves the conversation instead.
func sessionIDFromMetadata(headers map[string][]string, metadata map[string]any) string {
	if metadata == nil {
		return ""
	}
	_ = headers
	for _, key := range []string{"canonical_session_id", "derived_session_id"} {
		value, _ := metadata[key].(string)
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		if ValidSessionID(value) {
			return value
		}
		if idx := strings.LastIndex(value, ":"); idx >= 0 {
			candidate := strings.TrimSpace(value[idx+1:])
			if ValidSessionID(candidate) {
				return candidate
			}
		}
	}
	return ""
}

// handleExecute is the single inference seam for buffered and streaming
// requests. Order of checks (fail-closed, cheapest identity checks first):
//  1. configuration (enabled, endpoint, model allowlist),
//  2. credential parse + expiry admission BEFORE dispatch (an expired
//     access token would only burn an upstream 401; the plugin fails
//     locally instead and names the refresh handoff),
//  3. session identity: a real OpenCode session id, else the precise gap,
//  4. request shaping, then dispatch through the host transport.
func (h *Handler) handleExecute(request []byte, stream bool) ([]byte, error) {
	var req ExecutorRequest
	if err := decodeInto(request, &req); err != nil {
		return nil, err
	}
	if req.AuthProvider != "" && req.AuthProvider != ProviderKey {
		return nil, withStatus(400, fmt.Errorf("opencode cannot execute with another provider's credential"))
	}
	if !h.cfg.Enabled {
		return nil, withStatus(503, fmt.Errorf("opencode plugin is disabled"))
	}
	endpoint, err := InferenceEndpoint(h.cfg.InferenceBaseURL)
	if err != nil {
		return nil, withStatus(503, err)
	}
	upstreamModel := UpstreamModelID(req.Model)
	if !h.cfg.ModelAllowed(upstreamModel) {
		return nil, withStatus(404, fmt.Errorf("opencode model %q is not in the allowlist", req.Model))
	}
	credential, err := ParseCredential(req.StorageJSON.bytes())
	if err != nil {
		return nil, withStatus(401, fmt.Errorf("opencode credential is unavailable: %v", err))
	}
	nowMs := h.nowMs()
	if credential.ExpiredAt(nowMs) {
		// Expiry admission before dispatch: an expired token never reaches
		// the upstream. The error names the actual state and the owner.
		return nil, withStatus(401, fmt.Errorf("opencode access token is expired (expires %d, now %d); the credential must be refreshed by its single sequential refresh owner (the host auto-refresh loop drives auth.refresh; if it is not scheduled, seed a valid credential or arrange the refresh-owner handoff)", credential.Expiry(), nowMs))
	}
	metadataSessionID := sessionIDFromMetadata(req.Headers, req.Metadata)
	var sessionID, affinity string
	var release func()
	defer func() {
		if release != nil {
			release()
		}
	}()
	if metadataSessionID != "" || sessionIDFromHeaders(req.Headers) != "" {
		sessionID, affinity = SessionIdentity(sessionIDFromHeaders(req.Headers), metadataSessionID)
	} else {
		// No caller-supplied native identity: resolve (or mint) the
		// conversation's persistent provider session from the registry,
		// keyed by principal digest + host conversation identity.
		resolved, errResolve := h.sessionForRequest(req)
		if errResolve != nil {
			return nil, withStatus(422, errResolve)
		}
		sessionID, affinity = resolved, resolved
		registry := h.registry
		principal, conversation := principalDigest(req), conversationID(req.Metadata)
		release = func() { _ = registry.Release(principal, conversation) }
	}
	if !ValidSessionID(sessionID) {
		return nil, withStatus(422, fmt.Errorf("opencode dispatch session identity %q is not a native OpenCode session id; only caller-supplied native ids or registry-minted ids are forwarded", sessionID))
	}
	payload, err := shapeInferenceRequest(req.Payload.bytes(), upstreamModel)
	if err != nil {
		return nil, withStatus(400, err)
	}
	if stream && strings.TrimSpace(req.StreamID) == "" {
		return nil, withStatus(400, fmt.Errorf("opencode streaming execution requires the host stream id"))
	}
	if h.transport == nil {
		return nil, withStatus(503, fmt.Errorf("opencode host transport is unavailable"))
	}
	headers := InferenceHeaders(h.cfg.App(), sessionID, affinity, h.cfg.ProjectID, credential.Authorization())
	if !stream {
		result, errDo := h.transport.Do(WithHostCallbackID(context.Background(), req.HostCallbackID), "POST", endpoint, headers, payload)
		if errDo != nil {
			return nil, withStatus(502, fmt.Errorf("opencode upstream transport failed: %v", errDo))
		}
		if IsTerminalStatus(result.StatusCode) {
			rejection := ClassifyRejection(result.StatusCode, result.Headers, result.Body)
			return nil, rejection.statusError()
		}
		if result.StatusCode < 200 || result.StatusCode >= 300 {
			return nil, withStatus(502, fmt.Errorf("opencode upstream returned HTTP %d", result.StatusCode))
		}
		return okEnvelope(ExecutorResponse{
			Payload: result.Body,
			Headers: map[string][]string{"content-type": {"text/event-stream"}},
		})
	}
	response, err := h.handleExecuteStream(req, endpoint, headers, payload, release)
	if err == nil {
		release = nil
	} // async pump owns this exact registry lease
	return response, err
}

// handleExecuteStream relays an upstream SSE stream into the host plugin
// stream bridge. Rejection statuses and relay failures close the plugin
// stream with a structured error_detail (status + retry-after) so streamed
// and buffered requests record cooldown identically.
func (h *Handler) handleExecuteStream(req ExecutorRequest, endpoint string, headers map[string][]string, payload []byte, release func()) ([]byte, error) {
	result, err := h.transport.DoStream(WithHostCallbackID(context.Background(), req.HostCallbackID), "POST", endpoint, headers, payload)
	if err != nil {
		closeStreamWithError(req.StreamID, err)
		return nil, withStatus(502, fmt.Errorf("opencode upstream stream transport failed: %v", err))
	}
	if IsTerminalStatus(result.StatusCode) {
		defer h.transport.CloseStream(result)
		rejection := ClassifyRejection(result.StatusCode, result.Headers, nil)
		rejection.RequestID = "" // headers only; body was not buffered
		closeStreamWithRejection(req.StreamID, rejection)
		return nil, rejection.statusError()
	}
	if result.StatusCode < 200 || result.StatusCode >= 300 {
		defer h.transport.CloseStream(result)
		errUpstream := fmt.Errorf("opencode upstream returned HTTP %d", result.StatusCode)
		closeStreamWithError(req.StreamID, errUpstream)
		return nil, withStatus(502, errUpstream)
	}
	// Stream opened: acknowledge to the host and relay chunks
	// asynchronously, exactly like the host's async plugin protocol expects
	// (rpc_client_stream.go keeps callbacks alive until the stream ends).
	h.activeStreams.Add(1)
	go func() {
		defer h.activeStreams.Add(-1)
		defer func() {
			if recovered := recover(); recovered != nil {
				closeStreamWithError(req.StreamID, fmt.Errorf("opencode stream relay panic: %v", recovered))
			}
			if release != nil {
				release()
			}
		}()
		for chunk := range result.Chunks {
			if chunk.Err != nil {
				closeStreamWithError(req.StreamID, fmt.Errorf("opencode upstream stream failed: %v", chunk.Err))
				h.transport.CloseStream(result)
				return
			}
			if err := emitStreamChunk(req.StreamID, chunk.Payload); err != nil {
				closeStreamWithError(req.StreamID, err)
				h.transport.CloseStream(result)
				return
			}
		}
		h.transport.CloseStream(result)
	}()
	return okEnvelope(map[string]any{
		"headers": map[string][]string{"content-type": {"text/event-stream"}},
	})
}

// StreamEmitter relays one chunk into the host plugin stream bridge. The
// cgo entry point binds it to host.stream.emit; tests bind fakes.
var StreamEmitter func(streamID string, payload []byte) error

func emitStreamChunk(streamID string, payload []byte) error {
	if StreamEmitter == nil {
		return fmt.Errorf("opencode stream emitter is unavailable")
	}
	return StreamEmitter(streamID, payload)
}

// StreamCloser closes the plugin stream with an error. The cgo entry point
// binds it to host.stream.close; tests bind fakes.
var StreamCloser func(streamID string, err error)

func closeStreamWithError(streamID string, err error) {
	if StreamCloser == nil || strings.TrimSpace(streamID) == "" {
		return
	}
	StreamCloser(streamID, err)
}

func closeStreamWithRejection(streamID string, rejection *Rejection) {
	if StreamCloser == nil || strings.TrimSpace(streamID) == "" {
		return
	}
	StreamCloser(streamID, rejection.statusError())
}

// conversationID extracts the host conversation identity for diagnostics.
func conversationID(metadata map[string]any) string {
	if metadata == nil {
		return ""
	}
	for _, key := range []string{"canonical_session_id", "derived_session_id"} {
		if value, _ := metadata[key].(string); strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

// principalDigest derives the registry principal from the executor request:
// a sha256 digest over the caller's authorization value (the same convention
// the gateway uses for principal-scoped keys). The raw secret is never
// stored, logged or persisted. An empty authorization yields an empty
// digest, which the registry rejects.
func principalDigest(req ExecutorRequest) string {
	authorization := ""
	if values := req.Headers["authorization"]; len(values) > 0 {
		authorization = strings.TrimSpace(values[0])
	}
	if authorization == "" {
		// The host stores the caller credential in StorageJSON metadata in
		// some lanes; the auth id is the stable per-credential identity.
		authorization = strings.TrimSpace(req.AuthID)
	}
	if authorization == "" {
		return ""
	}
	sum := sha256.Sum256([]byte(authorization))
	return "sha256-" + hex.EncodeToString(sum[:])
}

// sessionForRequest resolves the persistent provider session for a request
// through the registry: (principal digest, host conversation identity) ->
// minted session id. It wraps the dispatch in a Reference/Release lease so
// the mapping cannot be evicted mid-flight.
func (h *Handler) sessionForRequest(req ExecutorRequest) (string, error) {
	conversation := conversationID(req.Metadata)
	if strings.TrimSpace(conversation) == "" {
		return "", fmt.Errorf("opencode dispatch requires the host conversation identity (canonical_session_id metadata) to resolve the persistent provider session; the request carries none")
	}
	principal := principalDigest(req)
	if principal == "" {
		return "", fmt.Errorf("opencode dispatch requires a caller principal (authorization header or auth id) to bind the provider session to its owner; the request carries none")
	}
	if h.registry == nil {
		return "", fmt.Errorf("opencode session registry is unavailable")
	}
	return h.registry.Acquire(principal, conversation)
}

// releaseSessionLease releases the dispatch lease after the upstream call
// completes (buffered) or the stream ends (the relay releases it).
func (h *Handler) releaseSessionLease(req ExecutorRequest) {
	conversation := conversationID(req.Metadata)
	principal := principalDigest(req)
	if conversation == "" || principal == "" || h.registry == nil {
		return
	}
	_ = h.registry.Release(principal, conversation)
}

// handleExecutorHTTPRequest bridges only the native Console API GET surface
// (config discovery). Arbitrary upstream HTTP is refused.
func (h *Handler) handleExecutorHTTPRequest(request []byte) ([]byte, error) {
	var req struct {
		HostCallbackID string              `json:"host_callback_id,omitempty"`
		AuthProvider   string              `json:"AuthProvider"`
		Method         string              `json:"Method"`
		URL            string              `json:"URL"`
		Headers        map[string][]string `json:"Headers"`
		Body           wireBytes           `json:"Body"`
		StorageJSON    wireBytes           `json:"StorageJSON"`
	}
	if err := decodeInto(request, &req); err != nil {
		return nil, err
	}
	if req.AuthProvider != "" && req.AuthProvider != ProviderKey {
		return nil, withStatus(400, fmt.Errorf("opencode cannot bridge another provider's credential"))
	}
	if !h.cfg.Enabled {
		return nil, withStatus(503, fmt.Errorf("opencode plugin is disabled"))
	}
	if !strings.EqualFold(strings.TrimSpace(req.Method), "GET") {
		return nil, withStatus(501, fmt.Errorf("opencode plugin bridges GET requests only"))
	}
	credential, err := ParseCredential(req.StorageJSON.bytes())
	if err != nil {
		return nil, withStatus(401, fmt.Errorf("opencode credential is unavailable: %v", err))
	}
	if credential.ExpiredAt(h.nowMs()) {
		return nil, withStatus(401, fmt.Errorf("opencode access token is expired; the credential must be refreshed by its single refresh owner"))
	}
	if h.transport == nil {
		return nil, withStatus(500, fmt.Errorf("opencode plugin has no host transport"))
	}
	// Only same-service GETs under the credential's Console server are
	// bridged: the management surface (config discovery) is a Console API
	// call, which natively carries the x-org-id header.
	server := credential.Server()
	if err := validateConsoleConfigURL(server, req.URL); err != nil {
		return nil, withStatus(403, err)
	}
	consoleHeaders, err := credential.ConsoleHeaders()
	if err != nil {
		return nil, withStatus(500, err)
	}
	headerMap := map[string][]string{}
	// Caller headers cannot override or duplicate bearer/org/Host/cookie fields.
	headerMap["accept"] = []string{"application/json"}
	for name, value := range consoleHeaders {
		headerMap[name] = []string{value}
	}
	result, err := h.transport.Do(WithHostCallbackID(context.Background(), req.HostCallbackID), "GET", req.URL, headerMap, nil)
	if err != nil {
		return nil, withStatus(502, fmt.Errorf("opencode console transport failed: %v", err))
	}
	if IsTerminalStatus(result.StatusCode) {
		rejection := ClassifyRejection(result.StatusCode, result.Headers, result.Body)
		return nil, rejection.statusError()
	}
	return okEnvelope(map[string]any{
		"StatusCode": result.StatusCode,
		"Headers":    result.Headers,
		"Body":       result.Body,
	})
}

// handleSessionStats reports bounded registry diagnostics.
func (h *Handler) handleSessionStats() ([]byte, error) {
	if h.registry == nil {
		return okEnvelope(RegistryStats{})
	}
	return okEnvelope(h.registry.Stats())
}

// WithConfigured is a test helper returning the handler's effective config.
func (h *Handler) WithConfigured() PluginConfig {
	h.mu.RLock()
	defer h.mu.RUnlock()
	cfg := h.cfg
	cfg.Models = append([]string(nil), cfg.Models...)
	return cfg
}
