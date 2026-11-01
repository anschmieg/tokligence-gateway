// Package cline implements a CLIProxyAPI v8.0.49 dynamic-library plugin that
// owns Cline OAuth credentials and translates chat-completions requests to the
// Cline API. It is a first slice: parsing, refresh scheduling and request
// translation are implemented; live login and inference are reachable only
// through the host's own HTTP transport and are not exercised by tests.
package cline

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

// Storage shape persisted in the auth file (mirrors the pre-existing gateway
// credential format so an existing credential can be parsed without migration).
type Storage struct {
	AccessToken  string `json:"accessToken"`
	RefreshToken string `json:"refreshToken"`
	ExpiresAt    string `json:"expiresAt"`
}

const (
	// DefaultRefreshBuffer is how long before expiry a refresh is scheduled.
	DefaultRefreshBuffer = 5 * time.Minute
	// MinTokenFloor matches the upstream Cline adapter behavior: requests
	// below this ceiling are raised, never lowered.
	MinTokenFloor = 64
)

// ParseStorage decodes and validates a persisted credential payload.
func ParseStorage(raw []byte) (Storage, error) {
	var storage Storage
	if len(strings.TrimSpace(string(raw))) == 0 {
		return Storage{}, fmt.Errorf("cline credential storage is empty")
	}
	if err := json.Unmarshal(raw, &storage); err != nil {
		return Storage{}, fmt.Errorf("cline credential storage is invalid: %w", err)
	}
	storage.AccessToken = strings.TrimSpace(storage.AccessToken)
	storage.RefreshToken = strings.TrimSpace(storage.RefreshToken)
	storage.ExpiresAt = strings.TrimSpace(storage.ExpiresAt)
	if storage.AccessToken == "" || storage.RefreshToken == "" {
		return Storage{}, fmt.Errorf("cline credential storage is missing access or refresh token")
	}
	if _, err := ParseExpiry(storage.ExpiresAt); err != nil {
		return Storage{}, err
	}
	return storage, nil
}

// ParseExpiry parses the expiresAt timestamp carried by Cline credentials.
func ParseExpiry(value string) (time.Time, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return time.Time{}, fmt.Errorf("cline credential expiresAt is missing")
	}
	for _, layout := range []string{time.RFC3339, time.RFC3339Nano} {
		if parsed, err := time.Parse(layout, value); err == nil {
			return parsed.UTC(), nil
		}
	}
	// JavaScript Date.toISOString without milliseconds variant.
	if parsed, err := time.Parse("2006-01-02T15:04:05Z07:00", value); err == nil {
		return parsed.UTC(), nil
	}
	return time.Time{}, fmt.Errorf("cline credential expiresAt %q is invalid", value)
}

// TokenResponse is the shape returned by the Cline auth endpoints. Both the
// refresh response and the login register response use this envelope.
type TokenResponse struct {
	Success bool `json:"success"`
	Data    struct {
		AccessToken  string `json:"accessToken"`
		RefreshToken string `json:"refreshToken"`
		ExpiresAt    string `json:"expiresAt"`
	} `json:"data"`
}

// ParseTokenResponse validates a Cline token endpoint response and returns the
// storage to persist. fallbackRefreshToken is used when the endpoint rotates
// only the access token.
func ParseTokenResponse(body []byte, fallbackRefreshToken string) (Storage, error) {
	var payload TokenResponse
	if err := json.Unmarshal(body, &payload); err != nil {
		return Storage{}, fmt.Errorf("cline token response is invalid: %w", err)
	}
	if !payload.Success {
		return Storage{}, fmt.Errorf("cline token response reports failure")
	}
	accessToken := strings.TrimSpace(payload.Data.AccessToken)
	refreshToken := strings.TrimSpace(payload.Data.RefreshToken)
	if refreshToken == "" {
		refreshToken = strings.TrimSpace(fallbackRefreshToken)
	}
	if accessToken == "" || refreshToken == "" {
		return Storage{}, fmt.Errorf("cline token response is missing access or refresh token")
	}
	if _, err := ParseExpiry(payload.Data.ExpiresAt); err != nil {
		return Storage{}, err
	}
	return Storage{
		AccessToken:  accessToken,
		RefreshToken: refreshToken,
		ExpiresAt:    payload.Data.ExpiresAt,
	}, nil
}

// authIDNamespace separates cline auth IDs from other providers' auth IDs
// that could be derived from the same file name.
const authIDNamespace = "cline"

// AuthIDForFileName derives a stable, per-file auth ID. The host treats Auth.ID
// as a unique credential identifier across providers, so a bare "cline" would
// collide when more than one credential file exists; a namespaced, file-scoped
// ID keeps distinct files distinct and repeated parses of one file stable.
func AuthIDForFileName(fileName string) string {
	name := strings.TrimSpace(fileName)
	if name == "" {
		name = "cline.json"
	}
	return authIDNamespace + ":" + name
}

// NextRefreshAfter returns the time the host should refresh this credential.
// A credential that is already inside the refresh buffer refreshes at once.
func (s Storage) NextRefreshAfter(buffer time.Duration) time.Time {
	if buffer < 0 {
		buffer = DefaultRefreshBuffer
	}
	expiry, err := ParseExpiry(s.ExpiresAt)
	if err != nil {
		return time.Now().UTC()
	}
	next := expiry.Add(-buffer)
	if next.Before(time.Now().UTC()) {
		return time.Now().UTC()
	}
	return next.UTC()
}
