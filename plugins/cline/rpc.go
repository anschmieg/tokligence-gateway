package cline

import (
	"encoding/json"
	"fmt"
)

// envelope mirrors sdk/pluginabi.Envelope on the plugin side of the C ABI.
type envelope struct {
	OK     bool            `json:"ok"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  *envelopeError  `json:"error,omitempty"`
}

// envelopeError mirrors pluginabi.Error. HTTPStatus is surfaced to the client
// by the host when set; retry-after is intentionally never set because the
// gateway policy forbids retries after quota rejection.
type envelopeError struct {
	Code       string `json:"code"`
	Message    string `json:"message"`
	HTTPStatus int    `json:"http_status,omitempty"`
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
	status int
	err    error
}

func (e *statusError) Error() string { return e.err.Error() }
func (e *statusError) Unwrap() error { return e.err }

func withStatus(status int, err error) error {
	return &statusError{status: status, err: err}
}

// ErrorEnvelope builds the envelope error bytes for err (exported for the
// cgo entry point). It extracts an HTTP status when the error carries one.
func ErrorEnvelope(err error) []byte {
	if err == nil {
		return errorEnvelope("plugin_error", "unknown error")
	}
	status := 0
	if se, ok := err.(*statusError); ok {
		status = se.status
	}
	return errorEnvelope("plugin_error", err.Error(), status)
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
