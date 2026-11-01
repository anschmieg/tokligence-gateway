// Package opencode implements the OpenCode Console provider for the pinned
// mainline CLIProxyAPI v8.0.49 plugin host. Credential, refresh, header and
// request shapes are narrow ports of the actual pinned OpenCode source and are
// pinned per file in SOURCE-PINS.md.
package opencode

import (
	"encoding/json"
	"fmt"
	"strings"
)

// Native source pins (paths below are inside the pinned upstream archives;
// see SOURCE-PINS.md for version + SHA-256 of each archive):
//   - credential shape: packages/schema/src/credential.ts (Credential.OAuth)
//   - refresh grant: packages/core/src/plugin/provider/opencode.ts (oauth().refresh)
//   - Console headers: packages/core/src/console-access.ts (ConsoleAccess.headers)

const (
	// ProviderKey is the host provider key for OpenCode Console credentials.
	ProviderKey = "opencode"

	// ClientID is the native device-flow client id (opencode.ts: clientID).
	ClientID = "opencode-cli"

	// MethodDevice is the native integration method id (opencode.ts: methodID).
	MethodDevice = "device"

	// DefaultConsoleServer is the native default Console server
	// (console-access.ts: defaultServer).
	DefaultConsoleServer = "https://opencode.ai/console"

	// CredentialTypeOAuth is the native credential discriminator
	// (credential.ts: Schema.Literal("oauth")).
	CredentialTypeOAuth = "oauth"

	// signedOutMessage mirrors the native SignedOutError message: a 400
	// invalid_grant refresh means the session was revoked or expired and only
	// a new device login recovers (opencode.ts: signedOutMessage).
	signedOutMessage = "Reconnect OpenCode Console to continue"
)

// Credential is the native OpenCode OAuth credential value
// (schema/src/credential.ts: Credential.OAuth). It is the exact shape the
// OpenCode CLI persists in its credential store, so a seeded auth-dir file is
// interchangeable with a working client's export. metadata carries the
// account/org/server fields the native login flow records.
type Credential struct {
	Type     string          `json:"type"`
	MethodID string          `json:"methodID"`
	Access   string          `json:"access"`
	Refresh  string          `json:"refresh"`
	Expires  int64           `json:"expires"`
	Metadata json.RawMessage `json:"metadata,omitempty"`
}

// credentialMetadata is the native metadata record written by the device login
// flow (opencode.ts: credential(): server, accountID, email, orgID, orgName).
type credentialMetadata struct {
	Server    string `json:"server"`
	AccountID string `json:"accountID"`
	Email     string `json:"email"`
	OrgID     string `json:"orgID"`
	OrgName   string `json:"orgName"`
}

// ParseCredential decodes and validates a persisted credential payload. It
// accepts only the native OAuth shape: type "oauth", methodID "device", and a
// non-empty refresh token. The access token may be empty (an expired seed);
// expiry is validated before dispatch instead. Key-type and anonymous
// credentials are not this provider's shape and are declined so another
// parser can run.
func ParseCredential(raw []byte) (Credential, error) {
	var credential Credential
	if len(strings.TrimSpace(string(raw))) == 0 {
		return Credential{}, fmt.Errorf("opencode credential storage is empty")
	}
	if err := json.Unmarshal(raw, &credential); err != nil {
		return Credential{}, fmt.Errorf("opencode credential storage is invalid: %w", err)
	}
	if !strings.EqualFold(strings.TrimSpace(credential.Type), CredentialTypeOAuth) {
		return Credential{}, fmt.Errorf("opencode credential type is %q, want %q", credential.Type, CredentialTypeOAuth)
	}
	if strings.TrimSpace(credential.MethodID) == "" {
		return Credential{}, fmt.Errorf("opencode credential has no methodID")
	}
	if strings.TrimSpace(credential.Refresh) == "" {
		return Credential{}, fmt.Errorf("opencode credential has no refresh token")
	}
	return credential, nil
}

// Authorization returns the bearer value for inference requests. The native
// provider settings apply apiKey (which is the OAuth access token once the
// Console connection is resolved) through AuthOptions.bearer.
func (c Credential) Authorization() string {
	return "Bearer " + c.Access
}

// CredentialMetadata decodes the native credential metadata record. Missing
// metadata is not an error: org/server fields are optional in the native
// schema.
func (c Credential) CredentialMetadata() (credentialMetadata, error) {
	var metadata credentialMetadata
	if len(strings.TrimSpace(string(c.Metadata))) == 0 {
		return metadata, nil
	}
	if err := json.Unmarshal(c.Metadata, &metadata); err != nil {
		return metadata, fmt.Errorf("opencode credential metadata is invalid: %w", err)
	}
	return metadata, nil
}

// Server returns the Console server this credential signed in to, applying the
// native console.opencode.ai -> opencode.ai/console normalization
// (console-access.ts: server()).
func (c Credential) Server() string {
	metadata, err := c.CredentialMetadata()
	if err != nil {
		return DefaultConsoleServer
	}
	server := strings.TrimSpace(metadata.Server)
	if server == "" {
		return DefaultConsoleServer
	}
	// Native: credentials saved before August 2026 store the retired
	// console.opencode.ai host, which maps path-for-path onto the default.
	if strings.HasPrefix(server, "https://console.opencode.ai") &&
		(len(server) == len("https://console.opencode.ai") || server[len("https://console.opencode.ai")] == '/') {
		return DefaultConsoleServer + strings.TrimPrefix(server, "https://console.opencode.ai")
	}
	return server
}

// ConsoleHeaders returns the headers the native ConsoleAccess.headers()
// builds for Console API calls: the bearer token and, when the credential
// records an organization, the x-org-id header. Inference requests do NOT
// carry the org header natively (model-request.ts sends only the session/
// affinity/project/client/user-agent set); x-org-id belongs to Console API
// requests (config discovery, websearch, MCP attachment).
func (c Credential) ConsoleHeaders() (map[string]string, error) {
	headers := map[string]string{"authorization": c.Authorization()}
	metadata, err := c.CredentialMetadata()
	if err != nil {
		return nil, err
	}
	if orgID := strings.TrimSpace(metadata.OrgID); orgID != "" {
		headers["x-org-id"] = orgID
	}
	return headers, nil
}

// Expiry returns the access-token expiry. The native schema declares
// `expires` as NonNegativeInt milliseconds (credential.ts: expires:
// NonNegativeInt; written as Date.now() + expires_in * 1000).
func (c Credential) Expiry() int64 {
	return c.Expires
}

// ExpiredAt reports whether the access token is expired relative to nowMs
// (epoch milliseconds).
func (c Credential) ExpiredAt(nowMs int64) bool {
	if c.Expires <= 0 {
		// No recorded expiry: the native refresh path treats this as expiring
		// immediately (integration.ts expiring() has expires <= now + 5min).
		return true
	}
	return c.Expires <= nowMs
}

// NextRefreshAfter returns when the host should refresh, mirroring the native
// expiring() window (integration.ts: refresh when expires <= now + 5 min).
// A credential already inside the window refreshes immediately.
func (c Credential) NextRefreshAfter(nowMs int64, bufferMs int64) int64 {
	if bufferMs <= 0 {
		bufferMs = DefaultRefreshBufferMs
	}
	return c.Expires - bufferMs
}

// DefaultRefreshBufferMs is the native five-minute refresh lead
// (integration.ts: Duration.minutes(5)).
const DefaultRefreshBufferMs = 5 * 60 * 1000

// TokenResponse is the native device-token endpoint response
// (opencode.ts: Token struct: access_token, refresh_token, expires_in,
// org_id). The refresh grant rotates both tokens and returns relative
// expiry seconds.
type TokenResponse struct {
	AccessToken  string  `json:"access_token"`
	RefreshToken string  `json:"refresh_token"`
	ExpiresIn    float64 `json:"expires_in"`
	OrgID        *string `json:"org_id"`
}

// SignedOutError reports the native terminal refresh outcome: HTTP 400 with
// error invalid_grant. The Console session or refresh token was revoked or
// expired; only a new device login recovers. The plugin must never retry.
type SignedOutError struct {
	Detail string
}

func (e *SignedOutError) Error() string {
	if strings.TrimSpace(e.Detail) == "" {
		return signedOutMessage
	}
	return signedOutMessage + ": " + e.Detail
}

// IsSignedOut reports whether err is the terminal signed-out refresh outcome.
func IsSignedOut(err error) bool {
	for err != nil {
		if _, ok := err.(*SignedOutError); ok {
			return true
		}
		unwrapper, ok := err.(interface{ Unwrap() error })
		if !ok {
			return false
		}
		err = unwrapper.Unwrap()
	}
	return false
}

// RefreshTokenResponse validates a token-endpoint response and produces the
// next credential value, mirroring the native refresh implementation
// (opencode.ts: refresh):
//   - the rotated access/refresh tokens replace the stored ones,
//   - expiry is now + expires_in seconds (milliseconds epoch),
//   - a non-null org_id updates metadata.orgID and, when the org changed,
//     metadata.orgName falls back to the org id (the native flow only keeps
//     orgName when orgID matched).
//
// nowMs is injectable so tests are deterministic.
func RefreshTokenResponse(body []byte, current Credential, nowMs int64) (Credential, error) {
	var token TokenResponse
	if err := json.Unmarshal(body, &token); err != nil {
		return Credential{}, fmt.Errorf("opencode token response is invalid: %w", err)
	}
	accessToken := strings.TrimSpace(token.AccessToken)
	refreshToken := strings.TrimSpace(token.RefreshToken)
	if accessToken == "" || refreshToken == "" {
		return Credential{}, fmt.Errorf("opencode token response is missing access or refresh token")
	}
	if token.ExpiresIn <= 0 {
		return Credential{}, fmt.Errorf("opencode token response has no expires_in")
	}
	next := Credential{
		Type:     CredentialTypeOAuth,
		MethodID: current.MethodID,
		Access:   accessToken,
		Refresh:  refreshToken,
		Expires:  nowMs + int64(token.ExpiresIn*1000),
	}
	var metadata credentialMetadata
	if len(strings.TrimSpace(string(current.Metadata))) > 0 {
		if err := json.Unmarshal(current.Metadata, &metadata); err != nil {
			return Credential{}, fmt.Errorf("opencode credential metadata is invalid: %w", err)
		}
	}
	if token.OrgID != nil && strings.TrimSpace(*token.OrgID) != "" {
		orgID := strings.TrimSpace(*token.OrgID)
		if metadata.OrgID != orgID {
			metadata.OrgName = orgID
		}
		metadata.OrgID = orgID
	}
	rawMetadata, err := json.Marshal(metadata)
	if err != nil {
		return Credential{}, err
	}
	if string(rawMetadata) == "{}" {
		next.Metadata = nil
	} else {
		next.Metadata = rawMetadata
	}
	return next, nil
}
