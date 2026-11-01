package opencode

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

// Native source pins for this file (see SOURCE-PINS.md):
//   - host http bridge wire shapes: internal/pluginhost/host_callbacks.go
//     (rpcHostHTTPRequest / rpcHostHTTPStreamResponse and the
//     stream_read/stream_close structs in the pinned CLIProxyAPI v8.0.49 tree)
//   - stream relay: internal/pluginhost/rpc_client_stream.go (async plugins
//     emit chunks via host.stream.emit / host.stream.close with a
//     pluginabi.Error error_detail carrying status + retry-after)
//
// The plugin sends upstream HTTP exclusively through host.http.do /
// host.http.do_stream: proxy policy, request logging and physical-dispatch
// observability stay with the platform.

// HTTPResult is one upstream HTTP exchange outcome.
type HTTPResult struct {
	StatusCode int
	Headers    map[string][]string
	Body       []byte
}

// StreamResult is an upstream streaming outcome: status/headers first, then
// chunk payloads until the channel closes. A non-nil Err on a chunk fails
// the relay.
type StreamResult struct {
	StatusCode int
	Headers    map[string][]string
	Chunks     <-chan StreamChunk
}

type StreamChunk struct {
	Payload []byte
	Err     error
}

// Transport issues the plugin's upstream HTTP calls. The production
// implementation goes through the host bridge; tests provide fakes. No
// implementation here ever dials a socket itself.
type Transport interface {
	// Do performs one buffered HTTP exchange.
	Do(ctx context.Context, method, url string, headers map[string][]string, body []byte) (HTTPResult, error)
	// DoStream opens a streaming HTTP exchange and returns the chunk channel.
	DoStream(ctx context.Context, method, url string, headers map[string][]string, body []byte) (StreamResult, error)
	// CloseStream releases a stream returned by DoStream.
	CloseStream(result StreamResult)
}

// hostEnvelope is the JSON envelope every host callback returns.
type hostEnvelope struct {
	OK     bool             `json:"ok"`
	Result json.RawMessage  `json:"result,omitempty"`
	Error  *hostEnvelopeErr `json:"error,omitempty"`
}

type hostEnvelopeErr struct {
	Code       string `json:"code"`
	Message    string `json:"message"`
	HTTPStatus int    `json:"http_status,omitempty"`
}

// HostCall invokes a host callback method and returns the raw result bytes.
// The production implementation is bound in the cgo entry point.
type HostCall func(method string, payload []byte) ([]byte, error)

// HostBridge implements Transport over the host http callbacks. It is
// intentionally minimal: one buffered call and one streaming call, both
// through the host's proxy/request-log policy.
type HostBridge struct {
	call HostCall
}

// NewHostBridge builds a Transport over the host callback entry.
func NewHostBridge(call HostCall) *HostBridge {
	return &HostBridge{call: call}
}

// hostHTTPDoRequest is the wire shape of host.http.do
// (host_callbacks.go: rpcHostHTTPRequest).
type hostHTTPDoRequest struct {
	Method         string              `json:"method,omitempty"`
	URL            string              `json:"url,omitempty"`
	Headers        map[string][]string `json:"headers,omitempty"`
	Body           []byte              `json:"body,omitempty"`
	HostCallbackID string              `json:"host_callback_id,omitempty"`
}

// hostHTTPDoResponse is the wire shape host.http.do returns
// (pluginapi.HTTPResponse — untagged fields marshal with their Go names).
type hostHTTPDoResponse struct {
	StatusCode int                 `json:"StatusCode"`
	Headers    map[string][]string `json:"Headers"`
	Body       []byte              `json:"Body"`
}

// hostHTTPStreamOpenResponse is the wire shape host.http.do_stream returns
// (host_callbacks.go: rpcHostHTTPStreamResponse).
type hostHTTPStreamOpenResponse struct {
	StatusCode int                 `json:"status_code"`
	Headers    map[string][]string `json:"headers,omitempty"`
	StreamID   string              `json:"stream_id,omitempty"`
}

type hostStreamReadRequest struct {
	StreamID string `json:"stream_id"`
}

type hostStreamReadResponse struct {
	Payload []byte `json:"payload,omitempty"`
	Error   string `json:"error,omitempty"`
	Done    bool   `json:"done,omitempty"`
}

type hostStreamCloseRequest struct {
	StreamID string `json:"stream_id"`
}

// hostCallJSON marshals request, invokes the host callback, and decodes the
// envelope result into out (when non-nil).
func (b *HostBridge) hostCallJSON(ctx context.Context, method string, request any, out any) error {
	if b == nil || b.call == nil {
		return fmt.Errorf("host callback bridge is unavailable")
	}
	raw, err := marshalJSON(request)
	if err != nil {
		return fmt.Errorf("marshal host callback %s: %w", method, err)
	}
	rawResult, err := b.call(method, raw)
	if err != nil {
		return fmt.Errorf("host callback %s: %w", method, err)
	}
	var envelope hostEnvelope
	if err := unmarshalJSON(rawResult, &envelope); err != nil {
		return fmt.Errorf("decode host envelope %s: %w", method, err)
	}
	if !envelope.OK {
		if envelope.Error != nil && strings.TrimSpace(envelope.Error.Message) != "" {
			return fmt.Errorf("host callback %s failed: %s", method, envelope.Error.Message)
		}
		return fmt.Errorf("host callback %s failed", method)
	}
	if out == nil || len(envelope.Result) == 0 {
		return nil
	}
	if err := unmarshalJSON(envelope.Result, out); err != nil {
		return fmt.Errorf("decode host result %s: %w", method, err)
	}
	return nil
}

// Do performs one buffered host.http.do exchange.
func (b *HostBridge) Do(ctx context.Context, method, url string, headers map[string][]string, body []byte) (HTTPResult, error) {
	request := hostHTTPDoRequest{
		Method:  method,
		URL:     url,
		Headers: headers,
		Body:    body,
	}
	var response hostHTTPDoResponse
	if err := b.hostCallJSON(ctx, "host.http.do", request, &response); err != nil {
		return HTTPResult{}, err
	}
	return HTTPResult{
		StatusCode: response.StatusCode,
		Headers:    response.Headers,
		Body:       response.Body,
	}, nil
}

// DoStream opens a streaming host.http.do_stream exchange and pumps the
// host-managed stream into a chunk channel until done.
func (b *HostBridge) DoStream(ctx context.Context, method, url string, headers map[string][]string, body []byte) (StreamResult, error) {
	request := hostHTTPDoRequest{
		Method:  method,
		URL:     url,
		Headers: headers,
		Body:    body,
	}
	var open hostHTTPStreamOpenResponse
	if err := b.hostCallJSON(ctx, "host.http.do_stream", request, &open); err != nil {
		return StreamResult{}, err
	}
	if strings.TrimSpace(open.StreamID) == "" {
		return StreamResult{}, fmt.Errorf("host http stream bridge returned no stream id")
	}
	chunks := make(chan StreamChunk)
	go func() {
		defer close(chunks)
		for {
			var read hostStreamReadResponse
			if err := b.hostCallJSON(ctx, "host.http.stream_read", hostStreamReadRequest{StreamID: open.StreamID}, &read); err != nil {
				chunks <- StreamChunk{Err: err}
				return
			}
			if len(read.Payload) > 0 {
				chunks <- StreamChunk{Payload: read.Payload}
			}
			if read.Error != "" {
				chunks <- StreamChunk{Err: errors.New(read.Error)}
				return
			}
			if read.Done {
				return
			}
		}
	}()
	return StreamResult{
		StatusCode: open.StatusCode,
		Headers:    open.Headers,
		Chunks:     chunks,
	}, nil
}

// CloseStream releases the host stream after the relay finishes.
func (b *HostBridge) CloseStream(result StreamResult) {
	// The stream id is not carried on StreamResult by design: the host closes
	// its side when the read loop observes done/error, and the async executor
	// path closes the plugin stream instead. Nothing to do here.
	_ = result
}

var _ Transport = (*HostBridge)(nil)

func marshalJSON(value any) ([]byte, error) {
	return json.Marshal(value)
}

func unmarshalJSON(raw []byte, out any) error {
	return json.Unmarshal(raw, out)
}
