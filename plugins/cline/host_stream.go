package cline

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Host callback method names on the plugin RPC wire (pluginabi v1).
const (
	hostMethodDoStream    = "host.http.do_stream"
	hostMethodStreamRead  = "host.http.stream_read"
	hostMethodStreamClose = "host.http.stream_close"
)

// HostRPCFunc performs one host callback RPC and returns the unwrapped
// envelope result bytes, or an error for transport and plugin-error
// envelopes. It mirrors the cgo callHost shim: method plus request payload
// in, decoded result out.
type HostRPCFunc func(method string, payload []byte) ([]byte, error)

// HostStreamRequest describes one upstream streaming HTTP call issued
// through the host.http.do_stream callback.
type HostStreamRequest struct {
	// HostCallbackID identifies the open host callback context. It rides
	// each request because the host validates it per call.
	HostCallbackID string
	// Method is the upstream HTTP method.
	Method string
	// URL is the absolute upstream URL.
	URL string
	// Headers contains request headers.
	Headers map[string][]string
	// Body contains the raw request body.
	Body []byte
}

// HostStreamResponse is the opening response of a host streaming HTTP call.
type HostStreamResponse struct {
	// StatusCode is the upstream HTTP status code.
	StatusCode int
	// Headers contains upstream response headers.
	Headers map[string][]string
	// Body streams the upstream payload until EOF. Close must be called
	// exactly once to release the host-side stream.
	Body io.ReadCloser
}

// UpstreamStatusError reports a non-2xx upstream response that was rejected
// before its body was consumed as SSE.
type UpstreamStatusError struct {
	// StatusCode is the upstream HTTP status code.
	StatusCode int
	// RetryAfter preserves an upstream Retry-After hint; 0 when absent,
	// unparsable, or non-positive.
	RetryAfter time.Duration
	// Message describes the rejection.
	Message string
}

func (e *UpstreamStatusError) Error() string {
	if e.Message != "" {
		return e.Message
	}
	return fmt.Sprintf("cline upstream returned status %d", e.StatusCode)
}

// HostStreamClient issues streaming upstream HTTP calls through an injected
// host RPC function. It performs exactly one do_stream call per DoStream;
// it never retries.
type HostStreamClient struct {
	rpc HostRPCFunc
}

// NewHostStreamClient builds a client over the given host RPC function.
func NewHostStreamClient(rpc HostRPCFunc) *HostStreamClient {
	return &HostStreamClient{rpc: rpc}
}

// hostStreamOpenRequest matches the host.http.do_stream request schema.
type hostStreamOpenRequest struct {
	HostCallbackID string              `json:"host_callback_id,omitempty"`
	Method         string              `json:"method,omitempty"`
	URL            string              `json:"url,omitempty"`
	Headers        map[string][]string `json:"headers,omitempty"`
	Body           []byte              `json:"body,omitempty"`
}

// hostStreamOpenResponse matches the host.http.do_stream result schema.
// The host never populates chunks on this response; payload arrives only
// via stream_read.
type hostStreamOpenResponse struct {
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

// DoStream opens one upstream streaming HTTP call. Non-2xx responses are
// rejected before any body byte is consumed as SSE; the host stream is
// closed best-effort and the upstream status plus Retry-After hint are
// preserved on the returned *UpstreamStatusError.
func (c *HostStreamClient) DoStream(req HostStreamRequest) (*HostStreamResponse, error) {
	if c == nil || c.rpc == nil {
		return nil, errors.New("cline: host rpc function is required")
	}
	payload, err := json.Marshal(hostStreamOpenRequest{
		HostCallbackID: req.HostCallbackID,
		Method:         req.Method,
		URL:            req.URL,
		Headers:        req.Headers,
		Body:           req.Body,
	})
	if err != nil {
		return nil, fmt.Errorf("cline: encode host stream request: %w", err)
	}
	raw, err := c.rpc(hostMethodDoStream, payload)
	if err != nil {
		return nil, fmt.Errorf("cline: host stream open: %w", err)
	}
	var open hostStreamOpenResponse
	if err := json.Unmarshal(raw, &open); err != nil {
		return nil, fmt.Errorf("cline: decode host stream response: %w", err)
	}
	if open.StatusCode < 200 || open.StatusCode >= 300 {
		if open.StreamID != "" {
			_ = closeHostStream(c.rpc, open.StreamID)
		}
		return nil, &UpstreamStatusError{
			StatusCode: open.StatusCode,
			RetryAfter: retryAfterFromHeaders(open.Headers),
			Message:    fmt.Sprintf("cline upstream returned status %d", open.StatusCode),
		}
	}
	if open.StreamID == "" {
		return nil, errors.New("cline: host stream response has no stream id")
	}
	return &HostStreamResponse{
		StatusCode: open.StatusCode,
		Headers:    open.Headers,
		Body: &HostStreamBody{
			rpc:      c.rpc,
			streamID: open.StreamID,
		},
	}, nil
}

// HostStreamBody reads one host HTTP stream via host.http.stream_read and
// releases it via host.http.stream_close. Reads are bounded: each Read
// issues at most one stream_read call and copies at most len(p) bytes from
// the buffered chunk. Any error is sticky. The host stream_close call is
// issued at most once for the lifetime of the body, whether abandoned on
// error or closed by the caller; the host tolerates a close of an
// already-closed stream id, so this stays correct when the host has also
// auto-closed a terminal stream.
type HostStreamBody struct {
	rpc       HostRPCFunc
	streamID  string
	closeOnce sync.Once
	readMu    sync.Mutex
	mu        sync.Mutex
	buf       []byte
	done      bool
	closed    bool
	err       error
}

var errHostStreamClosed = errors.New("cline: host stream is closed")

// Read returns the next buffered bytes, fetching at most one chunk from the
// host when the buffer is empty.
func (b *HostStreamBody) Read(p []byte) (int, error) {
	if len(p) == 0 {
		return 0, nil
	}
	b.readMu.Lock()
	defer b.readMu.Unlock()

	b.mu.Lock()
	if b.err != nil {
		defer b.mu.Unlock()
		return 0, b.err
	}
	if b.closed {
		b.mu.Unlock()
		return 0, errHostStreamClosed
	}
	if len(b.buf) > 0 {
		n := copy(p, b.buf)
		b.buf = b.buf[n:]
		b.mu.Unlock()
		return n, nil
	}
	if b.done {
		b.mu.Unlock()
		return 0, io.EOF
	}
	b.mu.Unlock()

	resp, err := b.readChunk()
	b.mu.Lock()
	if b.closed {
		b.mu.Unlock()
		return 0, errHostStreamClosed
	}
	if err != nil {
		b.failLocked(err)
		defer b.mu.Unlock()
		return 0, b.err
	}
	if resp.Error != "" {
		b.failLocked(errors.New(resp.Error))
		defer b.mu.Unlock()
		return 0, b.err
	}
	if len(resp.Payload) == 0 && !resp.Done {
		b.failLocked(errors.New("cline: host http stream returned an empty chunk"))
		defer b.mu.Unlock()
		return 0, b.err
	}
	if len(resp.Payload) > 0 {
		b.buf = resp.Payload
	}
	if resp.Done {
		b.done = true
		// The host auto-closes its registry entry on a terminal read;
		// release our side through the same once-guard so exactly one
		// stream_close is ever sent for this stream.
		b.closeOnce.Do(func() { _ = b.sendClose() })
	}
	if len(b.buf) == 0 {
		// An empty non-done chunk was rejected above, so done is set here.
		b.mu.Unlock()
		return 0, io.EOF
	}
	n := copy(p, b.buf)
	b.buf = b.buf[n:]
	b.mu.Unlock()
	return n, nil
}

// Close releases the host stream. It is idempotent and sends
// host.http.stream_close at most once, even when called concurrently with
// an in-flight Read.
func (b *HostStreamBody) Close() error {
	b.mu.Lock()
	b.closed = true
	b.mu.Unlock()
	var err error
	b.closeOnce.Do(func() { err = b.sendClose() })
	return err
}

func (b *HostStreamBody) readChunk() (*hostStreamReadResponse, error) {
	payload, err := json.Marshal(hostStreamReadRequest{StreamID: b.streamID})
	if err != nil {
		return nil, fmt.Errorf("cline: encode host stream read: %w", err)
	}
	raw, err := b.rpc(hostMethodStreamRead, payload)
	if err != nil {
		return nil, fmt.Errorf("cline: host stream read: %w", err)
	}
	var resp hostStreamReadResponse
	if err := json.Unmarshal(raw, &resp); err != nil {
		return nil, fmt.Errorf("cline: decode host stream read response: %w", err)
	}
	return &resp, nil
}

// failLocked records a sticky error and abandons the host stream. Called
// with b.mu held; sendClose must not take b.mu.
func (b *HostStreamBody) failLocked(err error) {
	b.err = err
	b.closed = true
	b.closeOnce.Do(func() { _ = b.sendClose() })
}

func (b *HostStreamBody) sendClose() error {
	return closeHostStream(b.rpc, b.streamID)
}

func closeHostStream(rpc HostRPCFunc, streamID string) error {
	payload, err := json.Marshal(hostStreamCloseRequest{StreamID: streamID})
	if err != nil {
		return fmt.Errorf("cline: encode host stream close: %w", err)
	}
	if _, err := rpc(hostMethodStreamClose, payload); err != nil {
		return fmt.Errorf("cline: host stream close: %w", err)
	}
	return nil
}

// retryAfterFromHeaders extracts a Retry-After duration from upstream
// response headers, tolerating missing, unparsable, and non-positive values.
func retryAfterFromHeaders(headers map[string][]string) time.Duration {
	for name, values := range headers {
		if !strings.EqualFold(name, "Retry-After") || len(values) == 0 {
			continue
		}
		return parseRetryAfterValue(values[0])
	}
	return 0
}

const maxRetryAfterSeconds = int64(math.MaxInt64) / int64(time.Second)

func parseRetryAfterValue(raw string) time.Duration {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return 0
	}
	if secs, err := strconv.Atoi(raw); err == nil {
		if secs <= 0 {
			return 0
		}
		if int64(secs) > maxRetryAfterSeconds {
			return time.Duration(maxRetryAfterSeconds) * time.Second
		}
		return time.Duration(secs) * time.Second
	}
	if at, err := http.ParseTime(raw); err == nil {
		d := time.Until(at)
		if d <= 0 {
			return 0
		}
		return d
	}
	return 0
}
