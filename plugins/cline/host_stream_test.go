package cline

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// fakeHostRPC implements the host callback surface in memory: do_stream
// produces a queued chunk stream, stream_read drains it, stream_close marks
// the stream closed. No HTTP, no host process — pure wire fixtures.
type fakeHostRPC struct {
	mu sync.Mutex

	// open configuration
	statusCode int
	headers    map[string][]string
	chunks     []string // streamed in order; each becomes one stream_read payload
	failReadAt int      // inject chunk.Error at this 0-based read index; -1 disables
	readErr    error    // fail the stream_read RPC itself
	closeErr   error    // fail the stream_close RPC itself
	dropStream bool     // omit stream_id from the do_stream result

	// observed state
	openCalls    int
	readCalls    int
	closeCalls   int
	lastMethod   string
	lastPayloads map[string][]byte
	closed       bool
}

func newFakeHostRPC(chunks ...string) *fakeHostRPC {
	return &fakeHostRPC{
		statusCode:   200,
		failReadAt:   -1,
		lastPayloads: map[string][]byte{},
		chunks:       chunks,
	}
}

func (f *fakeHostRPC) call(method string, payload []byte) ([]byte, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.lastMethod = method
	f.lastPayloads[method] = append([]byte(nil), payload...)
	switch method {
	case hostMethodDoStream:
		f.openCalls++
		result := hostStreamOpenResponse{
			StatusCode: f.statusCode,
			Headers:    f.headers,
		}
		if !f.dropStream {
			result.StreamID = "stream-1"
		}
		raw, err := json.Marshal(result)
		if err != nil {
			return nil, err
		}
		return raw, nil
	case hostMethodStreamRead:
		if f.readErr != nil {
			return nil, f.readErr
		}
		idx := f.readCalls
		f.readCalls++
		if f.failReadAt >= 0 && idx == f.failReadAt {
			raw, err := json.Marshal(hostStreamReadResponse{Error: "upstream reset mid-stream", Done: true})
			if err != nil {
				return nil, err
			}
			return raw, nil
		}
		resp := hostStreamReadResponse{}
		if idx < len(f.chunks) {
			resp.Payload = []byte(f.chunks[idx])
		} else {
			resp.Done = true
		}
		raw, err := json.Marshal(resp)
		if err != nil {
			return nil, err
		}
		return raw, nil
	case hostMethodStreamClose:
		if f.closeErr != nil {
			return nil, f.closeErr
		}
		f.closeCalls++
		f.closed = true
		return json.Marshal(struct{}{})
	default:
		return nil, errors.New("unexpected host method " + method)
	}
}

// envelopeErrorRPC mimics a plugin-error envelope surfacing as a Go error,
// the way the cgo callHost shim unwraps {"ok":false,"error":{...}}.
func envelopeErrorRPC(method string, payload []byte) ([]byte, error) {
	return nil, errors.New("host callback failed: upstream connect error")
}

func openStream(t *testing.T, rpc *fakeHostRPC, headers map[string][]string) (*HostStreamClient, *HostStreamResponse) {
	t.Helper()
	client := NewHostStreamClient(rpc.call)
	resp, err := client.DoStream(HostStreamRequest{
		HostCallbackID: "cb-1",
		Method:         http.MethodPost,
		URL:            "https://api.example.com/v1/chat/completions",
		Headers:        map[string][]string{"Authorization": {"Bearer tok"}},
		Body:           []byte(`{"model":"claude-sonnet-4-5"}`),
	})
	if err != nil {
		t.Fatalf("DoStream: %v", err)
	}
	if resp == nil || resp.Body == nil {
		t.Fatal("DoStream returned nil response or body")
	}
	_ = headers
	t.Cleanup(func() { _ = resp.Body.Close() })
	return client, resp
}

func TestHostStreamClientDoStreamOpen(t *testing.T) {
	rpc := newFakeHostRPC()
	rpc.statusCode = 200
	rpc.headers = map[string][]string{"Content-Type": {"text/event-stream"}}

	_, resp := openStream(t, rpc, nil)

	if resp.StatusCode != 200 {
		t.Fatalf("StatusCode = %d, want 200", resp.StatusCode)
	}
	if got := resp.Headers["Content-Type"]; len(got) != 1 || got[0] != "text/event-stream" {
		t.Fatalf("Headers = %v, want text/event-stream", resp.Headers)
	}

	// Verify the do_stream request wire fixture exactly.
	var req map[string]any
	if err := json.Unmarshal(rpc.lastPayloads[hostMethodDoStream], &req); err != nil {
		t.Fatalf("decode do_stream payload: %v", err)
	}
	if req["host_callback_id"] != "cb-1" {
		t.Fatalf("host_callback_id = %v", req["host_callback_id"])
	}
	if req["method"] != http.MethodPost || req["url"] != "https://api.example.com/v1/chat/completions" {
		t.Fatalf("method/url = %v/%v", req["method"], req["url"])
	}
	body, ok := req["body"].(string)
	if !ok {
		t.Fatalf("body missing or not a base64 string: %v", req["body"])
	}
	decoded, err := base64.StdEncoding.DecodeString(body)
	if err != nil {
		t.Fatalf("body is not valid base64: %v", err)
	}
	if string(decoded) != `{"model":"claude-sonnet-4-5"}` {
		t.Fatalf("body = %q", decoded)
	}
}

func TestHostStreamBodyReadsChunksUntilDone(t *testing.T) {
	rpc := newFakeHostRPC(`data: {"delta":"he`, "llo\"}\n\n", "data: [DONE]\n\n")
	_, resp := openStream(t, rpc, nil)

	all, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("ReadAll: %v", err)
	}
	want := "data: {\"delta\":\"hello\"}\n\n" + "data: [DONE]\n\n"
	if string(all) != want {
		t.Fatalf("body = %q, want %q", all, want)
	}
	if rpc.readCalls != 4 { // 3 payload chunks + 1 done marker
		t.Fatalf("readCalls = %d, want 4", rpc.readCalls)
	}
	// Terminal done must close the host stream exactly once.
	if rpc.closeCalls != 1 {
		t.Fatalf("closeCalls after done = %d, want 1", rpc.closeCalls)
	}
	// Reading after done keeps returning EOF without new RPCs.
	if n, err := resp.Body.Read(make([]byte, 8)); err != io.EOF || n != 0 {
		t.Fatalf("post-EOF Read = %d, %v; want 0, io.EOF", n, err)
	}
	if rpc.readCalls != 4 {
		t.Fatalf("readCalls after post-EOF read = %d, want 4", rpc.readCalls)
	}
}

func TestHostStreamBodyBuffersPartialChunks(t *testing.T) {
	rpc := newFakeHostRPC("abcdef")
	_, resp := openStream(t, rpc, nil)

	buf := make([]byte, 2)
	var got strings.Builder
	for {
		n, err := resp.Body.Read(buf)
		got.Write(buf[:n])
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatalf("Read: %v", err)
		}
	}
	if got.String() != "abcdef" {
		t.Fatalf("body = %q, want abcdef", got.String())
	}
	// The 6-byte chunk was served from the buffer across 3 Reads: exactly
	// one stream_read plus the done read.
	if rpc.readCalls != 2 {
		t.Fatalf("readCalls = %d, want 2", rpc.readCalls)
	}
}

func TestHostStreamBodyCloseOnce(t *testing.T) {
	rpc := newFakeHostRPC("x")
	_, resp := openStream(t, rpc, nil)

	if err := resp.Body.Close(); err != nil {
		t.Fatalf("first Close: %v", err)
	}
	if err := resp.Body.Close(); err != nil {
		t.Fatalf("second Close: %v", err)
	}
	if rpc.closeCalls != 1 {
		t.Fatalf("closeCalls = %d, want 1", rpc.closeCalls)
	}
	// Read after close must not hit the host.
	if _, err := resp.Body.Read(make([]byte, 4)); err == nil {
		t.Fatal("Read after Close succeeded, want error")
	}
	if rpc.readCalls != 0 {
		t.Fatalf("readCalls after Close = %d, want 0", rpc.readCalls)
	}
}

func TestHostStreamBodyCloseDuringRead(t *testing.T) {
	// Close concurrent with Reads must produce exactly one stream_close
	// call, whichever read wins. Loop to widen the interleaving window.
	for attempt := 0; attempt < 50; attempt++ {
		rpc := newFakeHostRPC("chunk-0", "chunk-1")
		_, resp := openStream(t, rpc, nil)

		buf := make([]byte, 64)
		if _, err := resp.Body.Read(buf); err != nil {
			t.Fatalf("first Read: %v", err)
		}
		var wg sync.WaitGroup
		wg.Add(2)
		go func() {
			defer wg.Done()
			_ = resp.Body.Close()
		}()
		go func() {
			defer wg.Done()
			_, _ = resp.Body.Read(buf)
		}()
		wg.Wait()
		if rpc.closeCalls != 1 {
			t.Fatalf("attempt %d: closeCalls = %d, want 1", attempt, rpc.closeCalls)
		}
		_ = resp.Body.Close()
	}
}

func TestHostStreamBodyAbandonsStreamOnRPCError(t *testing.T) {
	// stream_read fails on the second call; the first call must succeed.
	var calls int32
	base := newFakeHostRPC("first")
	rpcRPC := func(method string, p []byte) ([]byte, error) {
		if method == hostMethodStreamRead {
			if atomic.AddInt32(&calls, 1) == 2 {
				return nil, errors.New("host transport down")
			}
		}
		return base.call(method, p)
	}
	client := NewHostStreamClient(rpcRPC)
	resp, err := client.DoStream(HostStreamRequest{
		HostCallbackID: "cb-1",
		Method:         http.MethodPost,
		URL:            "https://api.example.com/v1/chat/completions",
	})
	if err != nil {
		t.Fatalf("DoStream: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()

	// First read succeeds from the fetched chunk... then the next read
	// hits the failing stream_read.
	buf := make([]byte, 64)
	n, err := resp.Body.Read(buf)
	if err != nil || string(buf[:n]) != "first" {
		t.Fatalf("first Read = %q, %v", buf[:n], err)
	}
	if _, err := resp.Body.Read(buf); err == nil {
		t.Fatal("second Read succeeded, want error")
	}
	// Error path must abandon the stream: close sent exactly once, sticky
	// error on subsequent reads, and no further stream_read RPCs.
	if base.closeCalls != 1 {
		t.Fatalf("closeCalls = %d, want 1", base.closeCalls)
	}
	if _, err := resp.Body.Read(buf); err == nil {
		t.Fatal("third Read succeeded, want sticky error")
	}
	if atomic.LoadInt32(&calls) != 2 {
		t.Fatalf("stream_read calls = %d, want 2", calls)
	}
}

func TestHostStreamBodySurfacesChunkError(t *testing.T) {
	rpc := newFakeHostRPC("ok-chunk")
	rpc.failReadAt = 1
	_, resp := openStream(t, rpc, nil)

	buf := make([]byte, 64)
	if _, err := resp.Body.Read(buf); err != nil {
		t.Fatalf("first Read: %v", err)
	}
	_, err := resp.Body.Read(buf)
	if err == nil || !strings.Contains(err.Error(), "upstream reset mid-stream") {
		t.Fatalf("Read error = %v, want upstream reset mid-stream", err)
	}
	if rpc.closeCalls != 1 {
		t.Fatalf("closeCalls = %d, want 1", rpc.closeCalls)
	}
	// The chunk error must not be reported as io.EOF.
	if errors.Is(err, io.EOF) {
		t.Fatal("chunk error surfaced as io.EOF")
	}
}

func TestHostStreamBodyRejectsEmptyNonDoneChunk(t *testing.T) {
	// A payload-less non-done response is a protocol violation, not EOF:
	// the plugin must not silently fabricate stream progress.
	rpc := newFakeHostRPC()
	rpc.failReadAt = -1
	// First read returns an empty non-done chunk.
	payload, err := json.Marshal(hostStreamReadResponse{})
	if err != nil {
		t.Fatal(err)
	}
	reads := 0
	rpcRPC := func(method string, p []byte) ([]byte, error) {
		if method == hostMethodStreamRead {
			reads++
			if reads == 1 {
				return payload, nil
			}
			return json.Marshal(hostStreamReadResponse{Done: true})
		}
		return rpc.call(method, p)
	}
	client := NewHostStreamClient(rpcRPC)
	resp, err := client.DoStream(HostStreamRequest{Method: http.MethodGet, URL: "https://x"})
	if err != nil {
		t.Fatalf("DoStream: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if _, err := resp.Body.Read(make([]byte, 8)); err == nil || strings.Contains(err.Error(), "EOF") {
		t.Fatalf("Read = %v, want empty-chunk error", err)
	}
}

func TestHostStreamClientRejectsNon2xx(t *testing.T) {
	rpc := newFakeHostRPC("should not be read")
	rpc.statusCode = 429
	rpc.headers = map[string][]string{"Retry-After": {"12"}}

	client := NewHostStreamClient(rpc.call)
	_, err := client.DoStream(HostStreamRequest{Method: http.MethodPost, URL: "https://x"})
	if err == nil {
		t.Fatal("DoStream succeeded on 429, want UpstreamStatusError")
	}
	var statusErr *UpstreamStatusError
	if !errors.As(err, &statusErr) {
		t.Fatalf("err = %T (%v), want *UpstreamStatusError", err, err)
	}
	if statusErr.StatusCode != 429 {
		t.Fatalf("StatusCode = %d, want 429", statusErr.StatusCode)
	}
	if statusErr.RetryAfter != 12*time.Second {
		t.Fatalf("RetryAfter = %v, want 12s", statusErr.RetryAfter)
	}
	// The rejected body must never be consumed: zero stream_read calls.
	if rpc.readCalls != 0 {
		t.Fatalf("readCalls = %d, want 0", rpc.readCalls)
	}
	// The opened stream must be released.
	if rpc.closeCalls != 1 {
		t.Fatalf("closeCalls = %d, want 1", rpc.closeCalls)
	}
}

func TestHostStreamClientMissingStreamID(t *testing.T) {
	rpc := newFakeHostRPC()
	rpc.dropStream = true
	client := NewHostStreamClient(rpc.call)
	_, err := client.DoStream(HostStreamRequest{Method: http.MethodGet, URL: "https://x"})
	if err == nil || !strings.Contains(err.Error(), "no stream id") {
		t.Fatalf("err = %v, want missing stream id error", err)
	}
}

func TestHostStreamClientRPCErrorPropagation(t *testing.T) {
	client := NewHostStreamClient(envelopeErrorRPC)
	_, err := client.DoStream(HostStreamRequest{Method: http.MethodGet, URL: "https://x"})
	if err == nil {
		t.Fatal("DoStream succeeded, want error")
	}
	var statusErr *UpstreamStatusError
	if errors.As(err, &statusErr) {
		t.Fatalf("RPC transport error must not surface as UpstreamStatusError: %v", err)
	}
	if !strings.Contains(err.Error(), "upstream connect error") {
		t.Fatalf("err = %v, want wrapped RPC error", err)
	}
}

func TestHostStreamRetryAfterParsing(t *testing.T) {
	cases := []struct {
		name    string
		headers map[string][]string
		want    time.Duration
	}{
		{"missing", nil, 0},
		{"delta seconds", map[string][]string{"Retry-After": {"30"}}, 30 * time.Second},
		{"case-insensitive", map[string][]string{"retry-after": {"5"}}, 5 * time.Second},
		{"http date", map[string][]string{"Retry-After": {time.Now().UTC().Add(90 * time.Second).Format(http.TimeFormat)}}, 0},
		{"unparsable", map[string][]string{"Retry-After": {"soon"}}, 0},
		{"negative", map[string][]string{"Retry-After": {"-3"}}, 0},
		{"zero", map[string][]string{"Retry-After": {"0"}}, 0},
		{"overflow", map[string][]string{"Retry-After": {"99999999999999999999"}}, 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := retryAfterFromHeaders(tc.headers)
			switch tc.name {
			case "http date":
				// A future date must yield a positive duration.
				if got <= 0 {
					t.Fatalf("http-date RetryAfter = %v, want > 0", got)
				}
				if got > 2*time.Minute {
					t.Fatalf("http-date RetryAfter = %v, want ~90s", got)
				}
			default:
				if got != tc.want {
					t.Fatalf("RetryAfter = %v, want %v", got, tc.want)
				}
			}
		})
	}
}

func TestHostStreamZeroValueClient(t *testing.T) {
	client := NewHostStreamClient(nil)
	if _, err := client.DoStream(HostStreamRequest{}); err == nil {
		t.Fatal("nil rpc must fail fast")
	}
}
