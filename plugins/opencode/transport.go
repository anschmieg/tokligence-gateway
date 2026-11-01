package opencode

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
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
// chunk payloads until the channel closes. Close releases the host stream;
// it is idempotent, so the consumer, the relay pump and CloseStream may all
// invoke it on any outcome, including caller abandonment.
type StreamResult struct {
	StatusCode int
	Headers    map[string][]string
	Chunks     <-chan StreamChunk
	// Close releases the host stream exactly once and unblocks the relay
	// pump when the consumer abandons the channel. Nil on a zero
	// StreamResult; CloseStream tolerates that.
	Close func()
}

type StreamChunk struct {
	Payload []byte
	Err     error
}

// hostCallbackIDKey carries the per-request host callback ID.
type hostCallbackIDKey struct{}

// WithHostCallbackID returns a context carrying the callback ID the bridge
// stamps onto every host.http.* request. Handlers open one callback context
// per request; there is deliberately no global callback context.
func WithHostCallbackID(ctx context.Context, id string) context.Context {
	if ctx == nil {
		ctx = context.Background()
	}
	return context.WithValue(ctx, hostCallbackIDKey{}, strings.TrimSpace(id))
}

// HostCallbackIDFromContext extracts the per-request callback ID, or "" when
// the context carries none.
func HostCallbackIDFromContext(ctx context.Context) string {
	if ctx == nil {
		return ""
	}
	id, _ := ctx.Value(hostCallbackIDKey{}).(string)
	return strings.TrimSpace(id)
}

// Transport issues the plugin's upstream HTTP calls. The production
// implementation goes through the host bridge; tests provide fakes. No
// implementation here ever dials a socket itself.
type Transport interface {
	// Do performs one buffered HTTP exchange. The context must carry the
	// per-request callback ID (WithHostCallbackID).
	Do(ctx context.Context, method, url string, headers map[string][]string, body []byte) (HTTPResult, error)
	// DoStream opens a streaming HTTP exchange and returns the chunk channel.
	// The context must carry the per-request callback ID (WithHostCallbackID).
	DoStream(ctx context.Context, method, url string, headers map[string][]string, body []byte) (StreamResult, error)
	// CloseStream releases a stream returned by DoStream. Safe to call
	// multiple times and on a zero StreamResult.
	CloseStream(result StreamResult)
}

// HostCall invokes a host callback method and returns the raw result bytes.
// The production cgo entry point has already unwrapped the RPC
// {ok,result,error} envelope: a nil error means raw result bytes, a non-nil
// error means the host rejected the callback. The bridge never re-wraps.
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

// hostHTTPDoRequest is the wire shape of host.http.do / host.http.do_stream
// (host_callbacks.go: rpcHostHTTPRequest). host_callback_id resolves the
// host operation, plugin identity and request-log context.
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
// raw result into out (when non-nil).
func (b *HostBridge) hostCallJSON(method string, request any, out any) error {
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
	if out == nil {
		return nil
	}
	if len(rawResult) == 0 {
		return fmt.Errorf("host callback %s returned no result", method)
	}
	if err := unmarshalJSON(rawResult, out); err != nil {
		return fmt.Errorf("decode host result %s: %w", method, err)
	}
	return nil
}

// Do performs one buffered host.http.do exchange. The request context must
// carry the per-request callback ID (WithHostCallbackID): the host resolves
// plugin identity, cancellation and request logging from it.
func (b *HostBridge) Do(ctx context.Context, method, url string, headers map[string][]string, body []byte) (HTTPResult, error) {
	callbackID := HostCallbackIDFromContext(ctx)
	if callbackID == "" {
		return HTTPResult{}, fmt.Errorf("host callback ID is required in request context")
	}
	if err := ctx.Err(); err != nil {
		return HTTPResult{}, err
	}
	request := hostHTTPDoRequest{
		Method:         method,
		URL:            url,
		Headers:        headers,
		Body:           body,
		HostCallbackID: callbackID,
	}
	var response hostHTTPDoResponse
	if err := b.hostCallJSON("host.http.do", request, &response); err != nil {
		return HTTPResult{}, err
	}
	if response.StatusCode < 100 || response.StatusCode > 599 {
		return HTTPResult{}, fmt.Errorf("host http bridge returned invalid status")
	}
	return HTTPResult{
		StatusCode: response.StatusCode,
		Headers:    response.Headers,
		Body:       response.Body,
	}, nil
}

// DoStream opens a streaming host.http.do_stream exchange and pumps the
// host-managed stream into a chunk channel until done. The request context
// must carry the per-request callback ID (WithHostCallbackID). The returned
// result owns the stream lifetime: Close releases the host stream exactly
// once on any outcome, including caller abandonment and context
// cancellation.
func (b *HostBridge) DoStream(ctx context.Context, method, url string, headers map[string][]string, body []byte) (StreamResult, error) {
	callbackID := HostCallbackIDFromContext(ctx)
	if callbackID == "" {
		return StreamResult{}, fmt.Errorf("host callback ID is required in request context")
	}
	if err := ctx.Err(); err != nil {
		return StreamResult{}, err
	}
	request := hostHTTPDoRequest{
		Method:         method,
		URL:            url,
		Headers:        headers,
		Body:           body,
		HostCallbackID: callbackID,
	}
	var open hostHTTPStreamOpenResponse
	if err := b.hostCallJSON("host.http.do_stream", request, &open); err != nil {
		return StreamResult{}, err
	}
	if strings.TrimSpace(open.StreamID) == "" {
		return StreamResult{}, fmt.Errorf("host http stream bridge returned no stream id")
	}

	chunks := make(chan StreamChunk)
	abandoned := make(chan struct{})
	var closeOnce sync.Once
	closeStream := func() {
		closeOnce.Do(func() {
			close(abandoned)
			raw, err := marshalJSON(hostStreamCloseRequest{StreamID: open.StreamID})
			if err != nil {
				return
			}
			_, _ = b.call("host.http.stream_close", raw)
		})
	}
	if open.StatusCode < 100 || open.StatusCode > 599 {
		closeStream()
		return StreamResult{}, fmt.Errorf("host http stream bridge returned invalid status")
	}
	// A blocked stream_read cannot observe local ctx.Err() itself. Closing
	// the host stream cancels its underlying HTTP/body read and releases it.
	stopCancel := context.AfterFunc(ctx, closeStream)

	go func() {
		defer close(chunks)
		defer closeStream()
		defer stopCancel()
		for {
			select {
			case <-abandoned:
				return
			default:
			}
			if err := ctx.Err(); err != nil {
				select {
				case chunks <- StreamChunk{Err: err}:
				case <-abandoned:
				}
				return
			}
			var read hostStreamReadResponse
			if err := b.hostCallJSON("host.http.stream_read", hostStreamReadRequest{StreamID: open.StreamID}, &read); err != nil {
				select {
				case chunks <- StreamChunk{Err: err}:
				case <-abandoned:
				}
				return
			}
			select {
			case <-abandoned:
				return
			default:
			}
			if len(read.Payload) > 0 {
				select {
				case chunks <- StreamChunk{Payload: read.Payload}:
				case <-abandoned:
					return
				}
			}
			if read.Error != "" {
				select {
				case chunks <- StreamChunk{Err: errors.New(read.Error)}:
				case <-abandoned:
				}
				return
			}
			if read.Done {
				return
			}
			if len(read.Payload) == 0 {
				// The host read blocks until a chunk, an error or done;
				// an empty non-done response is a protocol violation and
				// would otherwise spin this pump hot.
				errProtocol := fmt.Errorf("host http stream %s returned an empty non-done read", open.StreamID)
				select {
				case chunks <- StreamChunk{Err: errProtocol}:
				case <-abandoned:
				}
				return
			}
		}
	}()

	return StreamResult{
		StatusCode: open.StatusCode,
		Headers:    open.Headers,
		Chunks:     chunks,
		Close:      closeStream,
	}, nil
}

// CloseStream releases the host stream owned by result. Idempotent and
// nil-safe: every terminal outcome (done, error, cancellation, caller
// abandonment) funnels through the same close-once function.
func (b *HostBridge) CloseStream(result StreamResult) {
	if result.Close != nil {
		result.Close()
	}
}

var _ Transport = (*HostBridge)(nil)

func marshalJSON(value any) ([]byte, error) {
	return json.Marshal(value)
}

func unmarshalJSON(raw []byte, out any) error {
	return json.Unmarshal(raw, out)
}
