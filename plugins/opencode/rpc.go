package opencode

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"
)

// envelope mirrors sdk/pluginabi.Envelope on the plugin side of the C ABI.
type envelope struct {
	OK     bool            `json:"ok"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  *envelopeError  `json:"error,omitempty"`
}

// envelopeError mirrors pluginabi.Error. HTTPStatus is surfaced to the client
// by the host when set; RetryAfterSeconds carries upstream cooldown guidance.
type envelopeError struct {
	Code              string `json:"code"`
	Message           string `json:"message"`
	Retryable         bool   `json:"retryable,omitempty"`
	HTTPStatus        int    `json:"http_status,omitempty"`
	RetryAfterSeconds int    `json:"retry_after_seconds,omitempty"`
}

func okEnvelope(result any) ([]byte, error) {
	encoded, err := json.Marshal(result)
	if err != nil {
		return nil, err
	}
	return json.Marshal(envelope{OK: true, Result: encoded})
}

func errorEnvelope(code, message string, httpStatus ...int) []byte {
	status := 0
	if len(httpStatus) > 0 {
		status = httpStatus[0]
	}
	raw, _ := json.Marshal(envelope{OK: false, Error: &envelopeError{
		Code:       code,
		Message:    message,
		HTTPStatus: status,
	}})
	return raw
}

// statusError is an error that carries an HTTP status for the error envelope.
type statusError struct {
	status      int
	code        string
	detail      string
	retryAfterS int
	cause       error
}

func (e *statusError) Error() string {
	if strings.TrimSpace(e.detail) == "" {
		return e.code
	}
	return e.code + ": " + e.detail
}

// Unwrap exposes a wrapped terminal cause (e.g. SignedOutError) so
// classification helpers can see through the status wrapper.
func (e *statusError) Unwrap() error { return e.cause }

// StatusError is the exported view of an error that carries an HTTP status,
// a machine code and upstream retry guidance. The cgo entry point uses it to
// build structured stream error details.
type StatusError struct {
	inner *statusError
}

// AsStatusError extracts the structured form when err carries one.
func AsStatusError(err error) (*StatusError, bool) {
	if se, ok := err.(*statusError); ok {
		return &StatusError{inner: se}, true
	}
	return nil, false
}

// Status returns the HTTP status (0 when unset).
func (s *StatusError) Status() int { return s.inner.status }

// Code returns the machine-readable code.
func (s *StatusError) Code() string { return s.inner.code }

// RetryAfterSeconds returns upstream retry guidance (0 when unset).
func (s *StatusError) RetryAfterSeconds() int { return s.inner.retryAfterS }

func withStatus(status int, err error) error {
	if se, ok := err.(*statusError); ok {
		return se
	}
	// Preserve the cause so terminal-error classification (IsSignedOut) can
	// unwrap it; the statusError reports the status to the host.
	return &statusError{status: status, code: err.Error(), cause: err}
}

// ErrorEnvelope builds the envelope error bytes for err (exported for the
// cgo entry point). It extracts status, code and retry-after when the error
// carries them, so upstream 401/403/429 keep their client-visible status and
// cooldown semantics.
func ErrorEnvelope(err error) []byte {
	if err == nil {
		return errorEnvelope("plugin_error", "unknown error")
	}
	if se, ok := err.(*statusError); ok {
		code := se.code
		if code == "" {
			code = "plugin_error"
		}
		raw, _ := json.Marshal(envelope{OK: false, Error: &envelopeError{
			Code:              code,
			Message:           se.Error(),
			HTTPStatus:        se.status,
			RetryAfterSeconds: se.retryAfterS,
		}})
		return raw
	}
	return errorEnvelope("plugin_error", err.Error())
}

// decodeInto unmarshals a request payload into target, tolerating empty bodies.
func decodeInto(request []byte, target any) error {
	if len(request) == 0 {
		return nil
	}
	if err := json.Unmarshal(request, target); err != nil {
		return fmt.Errorf("invalid request payload: %w", err)
	}
	return nil
}

// wireBytes decodes the host's wire form for []byte fields: the host marshals
// requests with encoding/json, so []byte fields arrive base64-encoded. A nil
// or empty value stays nil. Verbatim strings that happen to be valid base64
// still decode, matching how the host's own plugin fixtures round-trip.
type wireBytes []byte

func (w *wireBytes) UnmarshalJSON(raw []byte) error {
	if string(raw) == "null" {
		*w = nil
		return nil
	}
	var encoded string
	if err := json.Unmarshal(raw, &encoded); err != nil {
		return err
	}
	if encoded == "" {
		*w = nil
		return nil
	}
	decoded, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return err
	}
	*w = decoded
	return nil
}

func (w wireBytes) bytes() []byte { return []byte(w) }
