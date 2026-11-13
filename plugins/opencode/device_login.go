package opencode

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"
)

// Native source pins for this file (packages/core/src/plugin/provider/
// opencode.ts of the pinned OpenCode source; see SOURCE-PINS.md):
//   - Device / Token / TokenPending / User / Org schemas (lines 60-84)
//   - oauth().authorize: POST {server}/auth/device/code with
//     {client_id: "opencode-cli", supports_org_scope: true}, verification
//     URL resolved against the server and required to be HTTP(S)
//     (lines 123-147)
//   - poll(): POST {server}/auth/device/token with
//     grant_type urn:ietf:params:oauth:grant-type:device_code, one token
//     attempt per wait; authorization_pending keeps the wait, slow_down
//     adds 5s, any other error fails the flow (lines 594-617)
//   - credential(): GET /api/user + /api/orgs with bearer/accept-json,
//     requested org_id else sorted (name, id) org, native metadata record
//     {server, accountID, email, orgID, orgName} (lines 619-650)
//   - get()/send(): JSON bodies, accept-json headers (lines 652-677)
//
// Divergences forced by the plugin API (host-compatible, documented): the
// native loop sleeps and retries itself; the host instead re-enters
// auth.login.poll, so this manager gates each poll by interval/expiry,
// performs at most one token POST per eligible call and never sleeps. State
// is opaque and consumed on success so a replay cannot mint a duplicate
// credential. Only the pinned DefaultConsoleServer is used; there is no
// caller-supplied endpoint. Errors are fixed text: server bodies and secret
// material are never echoed or logged, and stored state/fields are bounded.

const (
	// DeviceLoginStatus values mirror pluginapi.AuthLoginStatus.
	DeviceLoginStatusPending = "pending"
	DeviceLoginStatusSuccess = "success"
	DeviceLoginStatusError   = "error"

	// Bounds on concurrent opaque states and on upstream-supplied lifetimes.
	// These cap memory and how long a flow can pin state; they never widen
	// native windows (Console device codes are minutes, well inside these).
	maxDeviceLoginStates   = 16
	maxDeviceLoginTTLS     = 900 // 15 minutes
	maxDevicePollIntervalS = 60
	minDevicePollIntervalS = 1

	// deviceSlowDownStepS is the native slow_down increment (opencode.ts
	// poll(): Duration.sum(wait, Duration.seconds(5))).
	deviceSlowDownStepS = 5

	// Bounded field lengths for upstream-supplied strings (memory + log
	// safety). Real Console values are far smaller.
	maxDeviceCodeLen      = 2048
	maxUserCodeLen        = 256
	maxVerificationURLLen = 2048
)

// Fixed, sanitized poll outcomes. Never echo server error text or bodies.
const (
	deviceLoginPendingMessage = "authorization is pending; poll again after the interval"
	deviceLoginDeniedMessage  = "the device login was denied"
	deviceLoginExpiredMessage = "the device code expired; start a new login"
	deviceLoginUnknownMessage = "unknown or expired device login state; start a new login"
	deviceLoginForeignMessage = "the device authorization failed"
)

// DeviceLoginStartResponse mirrors pluginapi.AuthLoginStartResponse: fields
// marshal under their exact Go names.
type DeviceLoginStartResponse struct {
	Provider  string         `json:"Provider"`
	URL       string         `json:"URL"`
	State     string         `json:"State"`
	ExpiresAt time.Time      `json:"ExpiresAt"`
	Metadata  map[string]any `json:"Metadata"`
}

// DeviceLoginPollResponse mirrors pluginapi.AuthLoginPollResponse: fields
// marshal under their exact Go names.
type DeviceLoginPollResponse struct {
	Status  string     `json:"Status"`
	Message string     `json:"Message"`
	Auth    AuthData   `json:"Auth"`
	Auths   []AuthData `json:"Auths"`
}

// deviceLoginState keeps the raw device_code private. The display user_code
// is returned as instructions; only the opaque State is used for polling.
type deviceLoginState struct {
	deviceCode string
	intervalS  int
	nextPollAt time.Time
	expiresAt  time.Time
}

// DeviceLoginManager implements the native OpenCode Console device OAuth
// login over the existing Transport (host.http.do bridge). Callers open one
// callback context per call (WithHostCallbackID): Start and Poll pass the
// given context through unmodified. Polls are serialized per manager.
type DeviceLoginManager struct {
	mu        sync.Mutex
	transport Transport
	server    string
	nowMs     NowMs
	states    map[string]*deviceLoginState
	closed    bool
	app       AppInfo
}

// NewDeviceLoginManager builds a device login manager bound to the pinned
// native default Console server. No caller-supplied endpoint is accepted.
func NewDeviceLoginManager(transport Transport) *DeviceLoginManager {
	return newDeviceLoginManager(transport, DefaultConsoleServer, nil)
}

// newDeviceLoginManager is the unexported constructor; tests override the
// server (HTTPS or literal loopback) and clock.
func newDeviceLoginManager(transport Transport, server string, now NowMs) *DeviceLoginManager {
	if now == nil {
		now = func() int64 { return time.Now().UnixMilli() }
	}
	server = strings.TrimSpace(server)
	if server == "" {
		server = DefaultConsoleServer
	}
	return &DeviceLoginManager{
		transport: transport,
		server:    server,
		nowMs:     now,
		states:    map[string]*deviceLoginState{},
		app:       DefaultAppInfo(),
	}
}

// Close clears every pending login state. In-flight Poll calls finish their
// single token attempt, then observe the unknown-state outcome.
func (m *DeviceLoginManager) Close() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.states = map[string]*deviceLoginState{}
	m.closed = true
}

// deviceCodeResponse is the native Device schema (opencode.ts lines 60-66).
type deviceCodeResponse struct {
	DeviceCode              string  `json:"device_code"`
	UserCode                string  `json:"user_code"`
	VerificationURIComplete string  `json:"verification_uri_complete"`
	ExpiresIn               float64 `json:"expires_in"`
	Interval                float64 `json:"interval"`
}

// deviceCodeRequestBody is the exact native start body.
type deviceCodeRequestBody struct {
	ClientID         string `json:"client_id"`
	SupportsOrgScope bool   `json:"supports_org_scope"`
}

// deviceTokenRequestBody is the exact native poll body.
type deviceTokenRequestBody struct {
	GrantType  string `json:"grant_type"`
	DeviceCode string `json:"device_code"`
	ClientID   string `json:"client_id"`
}

// deviceTokenPollResponse is the native DeviceToken union
// (opencode.ts lines 67-74): access_token present selects the token branch,
// error the pending branch.
type deviceTokenPollResponse struct {
	Error string `json:"error"`
	TokenResponse
}

// deviceUserResponse is the native User schema (line 75).
type deviceUserResponse struct {
	ID    string `json:"id"`
	Email string `json:"email"`
}

// deviceOrgResponse is the native Org schema (line 76).
type deviceOrgResponse struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// Start performs the native oauth().authorize beginning: one POST to
// /auth/device/code, a bounded opaque state, and the native
// user_code/instructions/poll_interval metadata. The ctx must carry the
// per-call callback ID (WithHostCallbackID).
func (m *DeviceLoginManager) Start(ctx context.Context) (DeviceLoginStartResponse, error) {
	if m.transport == nil {
		return DeviceLoginStartResponse{}, fmt.Errorf("opencode device login has no host transport")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return DeviceLoginStartResponse{}, fmt.Errorf("opencode device login is closed")
	}
	m.evictExpiredLocked()
	if len(m.states) >= maxDeviceLoginStates {
		return DeviceLoginStartResponse{}, fmt.Errorf("opencode device login has too many pending flows; complete or wait out the existing ones")
	}
	result, err := m.postJSON(ctx, "/auth/device/code", deviceCodeRequestBody{
		ClientID:         ClientID,
		SupportsOrgScope: true,
	})
	if err != nil {
		return DeviceLoginStartResponse{}, fmt.Errorf("opencode device login transport failed")
	}
	if result.StatusCode < 200 || result.StatusCode >= 300 {
		return DeviceLoginStartResponse{}, fmt.Errorf("the OpenCode Console device code request failed (HTTP %d)", result.StatusCode)
	}
	var code deviceCodeResponse
	if len(result.Body) > 1<<20 {
		return DeviceLoginStartResponse{}, fmt.Errorf("the OpenCode Console device code response is too large")
	}
	if err := unmarshalJSON(result.Body, &code); err != nil || code.ExpiresIn < 1 || code.Interval < 1 || code.Interval > maxDevicePollIntervalS {
		return DeviceLoginStartResponse{}, fmt.Errorf("the OpenCode Console device code response is invalid")
	}
	deviceCode := strings.TrimSpace(code.DeviceCode)
	userCode := strings.TrimSpace(code.UserCode)
	if deviceCode == "" || len(deviceCode) > maxDeviceCodeLen ||
		userCode == "" || len(userCode) > maxUserCodeLen {
		return DeviceLoginStartResponse{}, fmt.Errorf("the OpenCode Console device code response is invalid")
	}
	verification, err := m.verificationURL(code.VerificationURIComplete)
	if err != nil {
		return DeviceLoginStartResponse{}, err
	}
	nowMs := m.nowMs()
	ttl := clampDeviceSeconds(code.ExpiresIn, 1, maxDeviceLoginTTLS)
	interval := clampDeviceSeconds(code.Interval, minDevicePollIntervalS, maxDevicePollIntervalS)
	state, err := newOpaqueLoginState()
	if err != nil {
		return DeviceLoginStartResponse{}, err
	}
	m.states[state] = &deviceLoginState{
		deviceCode: deviceCode,
		intervalS:  interval,
		nextPollAt: time.UnixMilli(nowMs + int64(interval)*1000),
		expiresAt:  time.UnixMilli(nowMs + int64(ttl)*1000),
	}
	return DeviceLoginStartResponse{
		Provider:  ProviderKey,
		URL:       verification,
		State:     state,
		ExpiresAt: time.UnixMilli(nowMs + int64(ttl)*1000),
		Metadata: map[string]any{
			"user_code":     userCode,
			"instructions":  "Enter code: " + userCode,
			"poll_interval": interval,
		},
	}, nil
}

// Poll performs at most one token POST for an eligible call and reports the
// fixed sanitized outcome: pending (gating, authorization_pending,
// slow_down with the native +5s pacing), success (state consumed, native
// credential built through EncodeCredentialStorage) or error (denied,
// expired, foreign error, unknown/replayed state). It never sleeps, retries,
// prints secrets or leaks response bodies. Persistence is host-owned. The
// ctx must carry the per-call callback ID (WithHostCallbackID).
func (m *DeviceLoginManager) Poll(ctx context.Context, state string) (DeviceLoginPollResponse, error) {
	if m.transport == nil {
		return DeviceLoginPollResponse{}, fmt.Errorf("opencode device login has no host transport")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	entry, ok := m.states[strings.TrimSpace(state)]
	if !ok {
		// Unknown, bogus or already-consumed (replayed) state: the fixed
		// outcome, with no request at all.
		return DeviceLoginPollResponse{
			Status:  DeviceLoginStatusError,
			Message: deviceLoginUnknownMessage,
		}, nil
	}
	now := time.UnixMilli(m.nowMs())
	if !now.Before(entry.expiresAt) {
		m.deleteStateLocked(state)
		return deviceLoginErrorPollResponse(deviceLoginExpiredMessage), nil
	}
	if now.Before(entry.nextPollAt) {
		// Interval gating: the flow is not eligible yet, no token POST.
		return deviceLoginPendingPollResponse(), nil
	}
	// Eligible: exactly one token POST, serialized under the manager mutex.
	result, err := m.postJSON(ctx, "/auth/device/token", deviceTokenRequestBody{
		GrantType:  "urn:ietf:params:oauth:grant-type:device_code",
		DeviceCode: entry.deviceCode,
		ClientID:   ClientID,
	})
	if err != nil {
		m.deleteStateLocked(state)
		return DeviceLoginPollResponse{}, fmt.Errorf("opencode device login transport failed")
	}
	if len(result.Body) > 1<<20 || (result.StatusCode != 400 && (result.StatusCode < 200 || result.StatusCode >= 300)) {
		m.deleteStateLocked(state)
		return DeviceLoginPollResponse{}, fmt.Errorf("the OpenCode Console device token request failed (HTTP %d)", result.StatusCode)
	}
	// The native union consumes any status (400 authorization_pending is
	// normal); shape only is discriminated.
	var token deviceTokenPollResponse
	if err := unmarshalJSON(result.Body, &token); err != nil {
		m.deleteStateLocked(state)
		return DeviceLoginPollResponse{}, fmt.Errorf("the OpenCode Console device token response is invalid (HTTP %d)", result.StatusCode)
	}
	switch {
	case strings.TrimSpace(token.AccessToken) != "":
		if result.StatusCode < 200 || result.StatusCode >= 300 {
			m.deleteStateLocked(state)
			return deviceLoginErrorPollResponse(deviceLoginForeignMessage), nil
		}
		return m.completeLoginLocked(ctx, state, token)
	case strings.TrimSpace(token.Error) != "":
		switch token.Error {
		case "authorization_pending":
			entry.nextPollAt = now.Add(time.Duration(entry.intervalS) * time.Second)
			return deviceLoginPendingPollResponse(), nil
		case "slow_down":
			// Native pacing: the added 5s sticks for the rest of the flow.
			entry.intervalS += deviceSlowDownStepS
			entry.nextPollAt = now.Add(time.Duration(entry.intervalS) * time.Second)
			return deviceLoginPendingPollResponse(), nil
		case "access_denied":
			m.deleteStateLocked(state)
			return deviceLoginErrorPollResponse(deviceLoginDeniedMessage), nil
		case "expired_token", "expired":
			m.deleteStateLocked(state)
			return deviceLoginErrorPollResponse(deviceLoginExpiredMessage), nil
		default:
			m.deleteStateLocked(state)
			return deviceLoginErrorPollResponse(deviceLoginForeignMessage), nil
		}
	default:
		m.deleteStateLocked(state)
		return DeviceLoginPollResponse{}, fmt.Errorf("the OpenCode Console device token response is invalid (HTTP %d)", result.StatusCode)
	}
}

// completeLoginLocked consumes the state (first, so a replayed poll can
// never mint a duplicate credential) and builds the native credential:
// GET /api/user + /api/orgs with bearer and accept JSON, native org
// selection (requested org_id first, else sorted by name then id), the
// native metadata record, and EncodeCredentialStorage for the host.
func (m *DeviceLoginManager) completeLoginLocked(ctx context.Context, state string, token deviceTokenPollResponse) (DeviceLoginPollResponse, error) {
	m.deleteStateLocked(state)
	accessToken := strings.TrimSpace(token.AccessToken)
	refreshToken := strings.TrimSpace(token.RefreshToken)
	if refreshToken == "" || token.ExpiresIn <= 0 || token.ExpiresIn > 366*24*60*60 || len(accessToken) > 65536 || len(refreshToken) > 65536 {
		return DeviceLoginPollResponse{}, fmt.Errorf("the OpenCode Console device token response is invalid")
	}
	userResult, err := m.getJSON(ctx, "/api/user", "Bearer "+accessToken)
	if err != nil {
		return DeviceLoginPollResponse{}, fmt.Errorf("opencode device login transport failed")
	}
	if userResult.StatusCode < 200 || userResult.StatusCode >= 300 {
		return deviceLoginErrorPollResponse(
			fmt.Sprintf("the device login could not load the Console account (HTTP %d)", userResult.StatusCode)), nil
	}
	var user deviceUserResponse
	if len(userResult.Body) > 1<<20 {
		return deviceLoginErrorPollResponse("the device login returned an oversized Console account"), nil
	}
	if err := unmarshalJSON(userResult.Body, &user); err != nil ||
		strings.TrimSpace(user.ID) == "" || strings.TrimSpace(user.Email) == "" {
		return deviceLoginErrorPollResponse("the device login returned an invalid Console account"), nil
	}
	orgsResult, err := m.getJSON(ctx, "/api/orgs", "Bearer "+accessToken)
	if err != nil {
		return DeviceLoginPollResponse{}, fmt.Errorf("opencode device login transport failed")
	}
	if orgsResult.StatusCode < 200 || orgsResult.StatusCode >= 300 {
		return deviceLoginErrorPollResponse(
			fmt.Sprintf("the device login could not load the Console organizations (HTTP %d)", orgsResult.StatusCode)), nil
	}
	var orgs []deviceOrgResponse
	if len(orgsResult.Body) > 1<<20 {
		return deviceLoginErrorPollResponse("the device login returned oversized Console organizations"), nil
	}
	if err := unmarshalJSON(orgsResult.Body, &orgs); err != nil {
		return deviceLoginErrorPollResponse("the device login returned invalid Console organizations"), nil
	}
	org, orgErr := selectLoginOrg(orgs, token.OrgID)
	if orgErr != nil {
		return deviceLoginErrorPollResponse("the OpenCode Console returned an unknown organization"), nil
	}
	nowMs := m.nowMs()
	metadata, err := deviceCredentialMetadataJSON(m.server, user, org)
	if err != nil {
		return DeviceLoginPollResponse{}, err
	}
	credential := Credential{
		Type:     CredentialTypeOAuth,
		MethodID: MethodDevice,
		Access:   accessToken,
		Refresh:  refreshToken,
		Expires:  nowMs + int64(token.ExpiresIn*1000),
		Metadata: metadata,
	}
	storageJSON, err := EncodeCredentialStorage(credential)
	if err != nil {
		return DeviceLoginPollResponse{}, err
	}
	auth := AuthData{
		Provider:         ProviderKey,
		ID:               ProviderKey + ":opencode-login-" + strings.TrimPrefix(state, "odl_") + ".json",
		FileName:         "opencode-login-" + strings.TrimPrefix(state, "odl_") + ".json",
		Label:            "OpenCode Console",
		StorageJSON:      storageJSON,
		Metadata:         map[string]any{"type": ProviderKey},
		Attributes:       map[string]string{"type": ProviderKey},
		NextRefreshAfter: time.UnixMilli(credential.NextRefreshAfter(nowMs, DefaultRefreshBufferMs)),
	}
	return DeviceLoginPollResponse{
		Status: DeviceLoginStatusSuccess,
		Auth:   auth,
		Auths:  []AuthData{auth},
	}, nil
}

// selectLoginOrg is the native org selection (opencode.ts credential(),
// lines 628-634): a requested org_id must match one of the user's orgs;
// otherwise the first org sorted by name then id wins.
func selectLoginOrg(orgs []deviceOrgResponse, requested *string) (*deviceOrgResponse, error) {
	if requested == nil {
		if len(orgs) == 0 {
			return nil, nil
		}
		sorted := make([]deviceOrgResponse, len(orgs))
		copy(sorted, orgs)
		sort.Slice(sorted, func(i, j int) bool {
			if sorted[i].Name != sorted[j].Name {
				return sorted[i].Name < sorted[j].Name
			}
			return sorted[i].ID < sorted[j].ID
		})
		return &sorted[0], nil
	}
	for i := range orgs {
		if orgs[i].ID == *requested {
			return &orgs[i], nil
		}
	}
	// Native message echoes the id; here it is fixed and sanitized.
	return nil, fmt.Errorf("the OpenCode Console returned an unknown organization")
}

// deviceCredentialMetadataJSON encodes the native metadata record through
// the existing credentialMetadata. Without a selected org the org keys are
// absent, matching the native undefined fields.
func deviceCredentialMetadataJSON(server string, user deviceUserResponse, org *deviceOrgResponse) (json.RawMessage, error) {
	metadata := credentialMetadata{Server: server, AccountID: user.ID, Email: user.Email}
	if org != nil {
		metadata.OrgID, metadata.OrgName = org.ID, org.Name
	}
	raw, err := json.Marshal(metadata)
	if err != nil {
		return nil, err
	}
	if org == nil {
		var dropped map[string]json.RawMessage
		if err := json.Unmarshal(raw, &dropped); err == nil {
			delete(dropped, "orgID")
			delete(dropped, "orgName")
			if raw, err = json.Marshal(dropped); err != nil {
				return nil, err
			}
		}
	}
	return raw, nil
}

// postJSON sends the native send() shape: a JSON body with content-type and
// accept application/json.
func (m *DeviceLoginManager) postJSON(ctx context.Context, path string, body any) (HTTPResult, error) {
	raw, err := marshalJSON(body)
	if err != nil {
		return HTTPResult{}, err
	}
	return m.transport.Do(ctx, "POST", m.server+path, map[string][]string{
		"content-type": {"application/json"},
		"accept":       {"application/json"},
		"user-agent":   {UserAgent(m.app)},
	}, raw)
}

// getJSON sends the native get() shape: bearer token and accept application/json.
func (m *DeviceLoginManager) getJSON(ctx context.Context, path, authorization string) (HTTPResult, error) {
	return m.transport.Do(ctx, "GET", m.server+path, map[string][]string{
		"accept":        {"application/json"},
		"authorization": {authorization},
		"user-agent":    {UserAgent(m.app)},
	}, nil)
}

// verificationURL is the native authorize check (opencode.ts lines 132-140):
// resolve the verification URL against the server and require HTTP(S).
func (m *DeviceLoginManager) verificationURL(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" || len(raw) > maxVerificationURLLen {
		return "", fmt.Errorf("the OpenCode Console returned an invalid device verification URL")
	}
	parsed, err := url.Parse(raw)
	if err != nil {
		return "", fmt.Errorf("the OpenCode Console returned an invalid device verification URL")
	}
	base, err := url.Parse(m.server + "/")
	if err != nil {
		return "", fmt.Errorf("the OpenCode Console returned an invalid device verification URL")
	}
	if !parsed.IsAbs() {
		parsed = base.ResolveReference(parsed)
	}
	if (parsed.Scheme != "https" && parsed.Scheme != "http") || parsed.Host == "" {
		return "", fmt.Errorf("the OpenCode Console returned a non-HTTP(S) device verification URL")
	}
	return parsed.String(), nil
}

func newOpaqueLoginState() (string, error) {
	raw := make([]byte, 16)
	if _, err := rand.Read(raw); err != nil {
		return "", fmt.Errorf("opencode device login could not mint an opaque state")
	}
	return "odl_" + hex.EncodeToString(raw), nil
}

// clampDeviceSeconds bounds an upstream-supplied seconds value.
func clampDeviceSeconds(value float64, min, max int) int {
	if value < float64(min) {
		return min
	}
	if value > float64(max) {
		return max
	}
	return int(value)
}

func (m *DeviceLoginManager) evictExpiredLocked() {
	now := time.UnixMilli(m.nowMs())
	for state, entry := range m.states {
		if !now.Before(entry.expiresAt) {
			delete(m.states, state)
		}
	}
}

func (m *DeviceLoginManager) deleteStateLocked(state string) {
	delete(m.states, strings.TrimSpace(state))
}

func deviceLoginPendingPollResponse() DeviceLoginPollResponse {
	return DeviceLoginPollResponse{
		Status:  DeviceLoginStatusPending,
		Message: deviceLoginPendingMessage,
	}
}

func deviceLoginErrorPollResponse(message string) DeviceLoginPollResponse {
	return DeviceLoginPollResponse{
		Status:  DeviceLoginStatusError,
		Message: message,
	}
}
