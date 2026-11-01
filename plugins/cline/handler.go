package cline

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

// ProviderKey is the provider identifier registered with the host for both the
// auth provider and executor capabilities.
const ProviderKey = "cline"

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
// model_provider and executor.
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
	ConfigYAML    []byte `json:"config_yaml"`
	SchemaVersion uint32 `json:"schema_version"`
}

// pluginConfig is the parsed plugins.configs.cline YAML subtree.
type pluginConfig struct {
	APIBaseURL      string       `yaml:"api_base_url" json:"api_base_url"`
	WorkOSBaseURL   string       `yaml:"workos_base_url" json:"workos_base_url"`
	Models          []ModelEntry `yaml:"models" json:"models"`
	RefreshBufferMs int          `yaml:"refresh_buffer_ms" json:"refresh_buffer_ms"`
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
	RawJSON  []byte    `json:"RawJSON"`
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
	StorageJSON    []byte            `json:"StorageJSON"`
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

// AuthLoginStartRequest mirrors pluginapi.AuthLoginStartRequest.
type AuthLoginStartRequest struct {
	Provider       string         `json:"Provider"`
	BaseURL        string         `json:"BaseURL"`
	Host           HostState      `json:"Host"`
	Metadata       map[string]any `json:"Metadata"`
	HostCallbackID string         `json:"host_callback_id,omitempty"`
}

// AuthLoginStartResponse mirrors pluginapi.AuthLoginStartResponse.
type AuthLoginStartResponse struct {
	Provider  string    `json:"Provider"`
	URL       string    `json:"URL"`
	State     string    `json:"State"`
	ExpiresAt time.Time `json:"ExpiresAt"`
}

// AuthLoginPollRequest mirrors pluginapi.AuthLoginPollRequest.
type AuthLoginPollRequest struct {
	Provider       string         `json:"Provider"`
	State          string         `json:"State"`
	Host           HostState      `json:"Host"`
	Metadata       map[string]any `json:"Metadata"`
	HostCallbackID string         `json:"host_callback_id,omitempty"`
}

// AuthLoginPollResponse mirrors pluginapi.AuthLoginPollResponse.
type AuthLoginPollResponse struct {
	Status  string   `json:"Status"`
	Message string   `json:"Message"`
	Auth    AuthData `json:"Auth,omitempty"`
}

// ModelRegistrationRequest mirrors pluginapi.ModelRegistrationRequest.
type ModelRegistrationRequest struct {
	Plugin               PluginMetadata `json:"Plugin"`
	MultiProviderModels  bool           `json:"multi_provider_models,omitempty"`
}

// StaticModelRequest mirrors pluginapi.StaticModelRequest.
type StaticModelRequest struct {
	Plugin               PluginMetadata `json:"Plugin"`
	Host                 HostState      `json:"Host"`
	MultiProviderModels  bool           `json:"multi_provider_models,omitempty"`
}

// AuthModelRequest mirrors pluginapi.AuthModelRequest.
type AuthModelRequest struct {
	Plugin         PluginMetadata    `json:"Plugin"`
	AuthID         string            `json:"AuthID"`
	AuthProvider   string            `json:"AuthProvider"`
	StorageJSON    []byte            `json:"StorageJSON"`
	Metadata       map[string]any    `json:"Metadata"`
	Attributes     map[string]string `json:"Attributes"`
	Host           HostState         `json:"Host"`
	HostCallbackID string            `json:"host_callback_id,omitempty"`
}

// ModelResponse mirrors pluginapi.ModelResponse.
type ModelResponse struct {
	Provider       string            `json:"Provider"`
	Models         []RegisteredModel `json:"Models"`
	AuthUpdate     AuthData          `json:"AuthUpdate"`
}

// Handler dispatches plugin RPC methods. Transport (host HTTP callback) is
// injected so tests can drive refresh with fixtures without any network.
type Handler struct {
	transport     Transport
	apiBaseURL    string
	workosBaseURL string
	refreshBuffer time.Duration
	catalog       *ModelCatalog
	streamDeps    *StreamDeps
}

// Transport issues the plugin's upstream HTTP calls through the host callback.
// The production implementation calls host.http.do; tests provide fixtures.
// hostCallbackID is the per-call host callback context opened by the host for
// the RPC method being served; it must be forwarded on every host.http.do
// call so the host attributes the request to this plugin instance.
type Transport interface {
	Do(hostCallbackID, method, url string, headers map[string][]string, body []byte) (status int, responseBody []byte, err error)
}

// NewHandler builds a handler with defaults; tests override the transport.
func NewHandler(transport Transport) *Handler {
	return &Handler{
		transport:     transport,
		apiBaseURL:    DefaultAPIBaseURL,
		workosBaseURL: DefaultWorkOSBaseURL,
		refreshBuffer: DefaultRefreshBuffer,
	}
}

// Configure applies the plugin configuration subtree. The host hands the
// original YAML subtree (yaml.v3, the same library upstream itself uses); the
// JSON fallback keeps harness fixtures readable. All validation happens on a
// copy first; the handler is only mutated after the whole config parses, so a
// rejected reconfigure never leaves a half-applied state.
func (h *Handler) Configure(raw []byte) error {
	if len(strings.TrimSpace(string(raw))) == 0 {
		return fmt.Errorf("cline plugin configuration is empty")
	}
	var cfg pluginConfig
	if err := yaml.Unmarshal(raw, &cfg); err != nil {
		return fmt.Errorf("cline plugin configuration is invalid: %w", err)
	}
	apiBaseURL := h.apiBaseURL
	if strings.TrimSpace(cfg.APIBaseURL) != "" {
		validated, err := SecureBaseURL(cfg.APIBaseURL)
		if err != nil {
			return fmt.Errorf("cline api_base_url is rejected: %w", err)
		}
		apiBaseURL = validated
	}
	workosBaseURL := h.workosBaseURL
	if strings.TrimSpace(cfg.WorkOSBaseURL) != "" {
		validated, err := SecureBaseURL(cfg.WorkOSBaseURL)
		if err != nil {
			return fmt.Errorf("cline workos_base_url is rejected: %w", err)
		}
		workosBaseURL = validated
	}
	refreshBuffer := h.refreshBuffer
	if cfg.RefreshBufferMs > 0 {
		refreshBuffer = time.Duration(cfg.RefreshBufferMs) * time.Millisecond
	}
	models, err := ParseModelConfig(mustJSON(cfg.Models))
	if err != nil {
		return err
	}
	h.apiBaseURL = apiBaseURL
	h.workosBaseURL = workosBaseURL
	h.refreshBuffer = refreshBuffer
	h.catalog = &ModelCatalog{Models: models}
	return nil
}

func mustJSON(value any) []byte {
	raw, _ := json.Marshal(value)
	return raw
}

// Registration builds the plugin.register response for the given schema.
func (h *Handler) Registration(schemaVersion uint32) RegistrationResponse {
	return RegistrationResponse{
		SchemaVersion: schemaVersion,
		Metadata: PluginMetadata{
			Name:             "tokligence-cline",
			Version:          "0.1.0",
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

// HandleMethod dispatches one plugin RPC method. It returns the envelope-ready
// result payload. An error carries an HTTP status when known.
func (h *Handler) HandleMethod(method string, request []byte) ([]byte, error) {
	switch method {
	case "plugin.register", "plugin.reconfigure":
		var req LifecycleRequest
		if err := decodeInto(request, &req); err != nil {
			return nil, err
		}
		if err := h.Configure(req.ConfigYAML); err != nil {
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
		return nil, withStatus(501, fmt.Errorf("cline device login is not implemented in this slice; use the existing gateway OAuth flow to produce a credential file"))
	case "auth.login.poll":
		return nil, withStatus(501, fmt.Errorf("cline device login polling is not implemented in this slice"))
	case "model.register":
		return h.handleModelRegister()
	case "model.static":
		return h.handleModelStatic()
	case "model.for_auth":
		return h.handleModelForAuth(request)
	case "executor.identifier":
		return okEnvelope(map[string]string{"identifier": ProviderKey})
	case "executor.execute":
		return h.handleExecute(request)
	case "executor.execute_stream":
		return h.handleExecuteStream(request)
	case "executor.count_tokens":
		return nil, withStatus(501, fmt.Errorf("cline token counting is not implemented in this slice"))
	case "executor.http_request":
		return nil, withStatus(501, fmt.Errorf("cline executor http passthrough is not implemented in this slice"))
	default:
		return nil, fmt.Errorf("unknown method: %s", method)
	}
}

func (h *Handler) handleAuthParse(request []byte) ([]byte, error) {
	var req AuthParseRequest
	if err := decodeInto(request, &req); err != nil {
		return nil, err
	}
	// A parser is invoked for its own provider only when the host routed by
	// req.Provider; a foreign provider's file that merely looks like ours must
	// never be claimed (it would steal another provider's credential).
	if provider := strings.TrimSpace(req.Provider); provider != "" && provider != ProviderKey {
		return okEnvelope(AuthParseResponse{Handled: false})
	}
	storage, err := ParseStorage(req.RawJSON)
	if err != nil {
		// Not ours: report unhandled so other parsers can run.
		return okEnvelope(AuthParseResponse{Handled: false})
	}
	fileName := strings.TrimSpace(req.FileName)
	if fileName == "" {
		fileName = "cline.json"
	}
	storageJSON, err := json.Marshal(storage)
	if err != nil {
		return nil, err
	}
	// Auth IDs must be unique per credential file, not per provider: the host
	// deduplicates and dispatches by ID. Keep it stable for one file name so
	// re-parses of the same credential stay the same identity.
	authID := AuthIDForFileName(fileName)
	return okEnvelope(AuthParseResponse{
		Handled: true,
		Auth: AuthData{
			Provider:         ProviderKey,
			ID:               authID,
			FileName:         fileName,
			Label:            "Cline (free)",
			StorageJSON:      storageJSON,
			Metadata:         map[string]any{"type": ProviderKey},
			NextRefreshAfter: storage.NextRefreshAfter(h.refreshBuffer),
		},
	})
}

func (h *Handler) handleAuthRefresh(request []byte) ([]byte, error) {
	var req AuthRefreshRequest
	if err := decodeInto(request, &req); err != nil {
		return nil, err
	}
	storage, err := ParseStorage(req.StorageJSON)
	if err != nil {
		return nil, withStatus(500, fmt.Errorf("cline refresh rejected: %v", err))
	}
	if h.transport == nil {
		return nil, withStatus(500, fmt.Errorf("cline refresh has no host transport"))
	}
	// A refresh of one provider's credential must never be accepted for a
	// request routed to a different provider.
	if provider := strings.TrimSpace(req.AuthProvider); provider != "" && provider != ProviderKey {
		return nil, withStatus(400, fmt.Errorf("cline refresh rejected: auth provider %q is not %q", provider, ProviderKey))
	}
	body, err := json.Marshal(map[string]any{
		"refreshToken": storage.RefreshToken,
		"grantType":    "refresh_token",
	})
	if err != nil {
		return nil, err
	}
	headers := RequestHeaders("")
	status, responseBody, err := h.transport.Do(req.HostCallbackID, "POST", h.apiBaseURL+"/api/v1/auth/refresh", headers, body)
	if err != nil {
		return nil, withStatus(502, fmt.Errorf("cline refresh transport failed: %v", err))
	}
	if status < 200 || status >= 300 {
		classification := ClassifyUpstreamError(status, responseBody)
		// 401/403 on refresh is terminal for this credential; never retry.
		return nil, withStatus(classification.StatusCode, fmt.Errorf("cline refresh failed: %s", classification.Message))
	}
	rotated, err := ParseTokenResponse(responseBody, storage.RefreshToken)
	if err != nil {
		return nil, withStatus(502, err)
	}
	storageJSON, err := json.Marshal(rotated)
	if err != nil {
		return nil, err
	}
	next := rotated.NextRefreshAfter(h.refreshBuffer)
	// Preserve the host-assigned identity: an auth record that loses its
	// ID/FileName/metadata on refresh would fork into a second credential.
	authID := strings.TrimSpace(req.AuthID)
	if authID == "" {
		authID = AuthIDForFileName(req.AuthProvider)
	}
	return okEnvelope(AuthRefreshResponse{
		Auth: AuthData{
			Provider:         ProviderKey,
			ID:               authID,
			StorageJSON:      storageJSON,
			Metadata:         req.Metadata,
			Attributes:       req.Attributes,
			NextRefreshAfter: next,
		},
		NextRefreshAfter: next,
	})
}

func (h *Handler) handleModelRegister() ([]byte, error) {
	if h.catalog == nil {
		return nil, fmt.Errorf("cline plugin is not configured")
	}
	return okEnvelope(PluginModels{
		Provider: ProviderKey,
		Models:   h.catalog.Models,
	})
}

// handleModelStatic answers model.static. With executor scope "oauth" the
// host skips static publication anyway, so no static models are offered.
func (h *Handler) handleModelStatic() ([]byte, error) {
	return okEnvelope(ModelResponse{Provider: ProviderKey})
}

// handleModelForAuth answers model.for_auth: the per-credential model
// publication path the host uses when the executor scope is "oauth". Only
// the credential's own provider is answered; a foreign provider's credential
// gets no models from this plugin.
func (h *Handler) handleModelForAuth(request []byte) ([]byte, error) {
	var req AuthModelRequest
	if err := decodeInto(request, &req); err != nil {
		return nil, err
	}
	if h.catalog == nil {
		return nil, fmt.Errorf("cline plugin is not configured")
	}
	if provider := strings.TrimSpace(req.AuthProvider); provider != "" && provider != ProviderKey {
		return okEnvelope(ModelResponse{})
	}
	return okEnvelope(ModelResponse{
		Provider: ProviderKey,
		Models:   h.catalog.Models,
	})
}

// SetStreamDeps injects the streaming collaborators (upstream client and
// host stream bridge). It must be called before executor.execute_stream;
// without it the method fails closed with 503.
func (h *Handler) SetStreamDeps(deps *StreamDeps) {
	h.streamDeps = deps
}

// ExecutorRequest mirrors pluginapi.ExecutorRequest (fields used by this slice).
type ExecutorRequest struct {
	AuthID          string              `json:"AuthID"`
	AuthProvider    string              `json:"AuthProvider"`
	Model           string              `json:"Model"`
	Stream          bool                `json:"Stream"`
	OriginalRequest []byte              `json:"OriginalRequest"`
	SourceFormat    string              `json:"SourceFormat"`
	Payload         []byte              `json:"Payload"`
	StorageJSON     []byte              `json:"StorageJSON"`
	Headers         map[string][]string `json:"Headers"`
	HostCallbackID  string              `json:"host_callback_id,omitempty"`
}

// ExecutorResponse mirrors pluginapi.ExecutorResponse.
type ExecutorResponse struct {
	Payload []byte              `json:"Payload"`
	Headers map[string][]string `json:"Headers,omitempty"`
}

func (h *Handler) handleExecute(request []byte) ([]byte, error) {
	var req ExecutorRequest
	if err := decodeInto(request, &req); err != nil {
		return nil, err
	}
	if h.catalog == nil {
		return nil, fmt.Errorf("cline plugin is not configured")
	}
	// A stream=true request must be rejected before any upstream call,
	// regardless of which executor method the host used to deliver it.
	if req.Stream {
		return nil, withStatus(501, fmt.Errorf("cline streaming inference is not implemented in this slice"))
	}
	if !h.catalog.Contains(req.Model) {
		return nil, withStatus(404, fmt.Errorf("cline model %q is not registered", req.Model))
	}
	storage, err := ParseStorage(req.StorageJSON)
	if err != nil {
		return nil, withStatus(401, fmt.Errorf("cline credential is unavailable: %v", err))
	}
	// Translation happens against the already-translated chat-completions
	// payload (the host translated the client format to the executor input
	// format "openai" before calling us).
	translated, _, err := TranslateChatRequest(req.Model, req.Payload)
	if err != nil {
		return nil, withStatus(400, err)
	}
	if h.transport == nil {
		// Fail closed: without the host transport no upstream call is possible,
		// and returning the translated request as a payload would fabricate a
		// successful inference response.
		return nil, withStatus(503, fmt.Errorf("cline upstream transport is unavailable"))
	}
	headers := RequestHeaders("")
	headers["Authorization"] = []string{AuthorizationHeader(storage.AccessToken)}
	status, responseBody, err := h.transport.Do(req.HostCallbackID, "POST", h.apiBaseURL+"/api/v1/chat/completions", headers, translated)
	if err != nil {
		return nil, withStatus(502, fmt.Errorf("cline upstream transport failed: %v", err))
	}
	if status < 200 || status >= 300 {
		classification := ClassifyUpstreamError(status, responseBody)
		return nil, withStatus(classification.StatusCode, fmt.Errorf("cline upstream failed: %s", classification.Message))
	}
	// HTTP 200 with a body that is not the Cline success envelope must not be
	// reported as a successful completion.
	normalized, err := NormalizeSuccessResponse(responseBody)
	if err != nil {
		return nil, withStatus(502, err)
	}
	return okEnvelope(ExecutorResponse{
		Payload: normalized,
		Headers: map[string][]string{"content-type": {"application/json"}},
	})
}

// NormalizeSuccessResponse validates an HTTP-2xx upstream body and unwraps the
// Cline {success,data} envelope when present. A malformed or unsuccessful
// body is an error, never a completion payload.
func NormalizeSuccessResponse(body []byte) ([]byte, error) {
	if len(body) == 0 {
		return nil, fmt.Errorf("cline upstream response body is empty")
	}
	var payload struct {
		Success *bool           `json:"success"`
		Data    json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return nil, fmt.Errorf("cline upstream response is not valid JSON: %w", err)
	}
	if payload.Success == nil {
		// Plain (non-enveloped) chat-completion body.
		return body, nil
	}
	if !*payload.Success {
		return nil, fmt.Errorf("cline upstream response reports failure")
	}
	if len(payload.Data) == 0 {
		return nil, fmt.Errorf("cline upstream response has no data payload")
	}
	return payload.Data, nil
}
