package opencode

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"
)

// recordingHost is a fake HostCall: it records every callback invocation and
// answers with a scripted handler. It never touches the network and never
// wraps results in an RPC envelope — the production cgo entry point unwraps
// {ok,result,error} before HostCall sees bytes, so fakes return raw result
// bytes exactly like callHost does.
type recordingHost struct {
	mu     sync.Mutex
	calls  []hostCallRecord
	handle func(method string, payload []byte) ([]byte, error)
}

type hostCallRecord struct {
	method  string
	payload []byte
}

func (h *recordingHost) call(method string, payload []byte) ([]byte, error) {
	h.mu.Lock()
	h.calls = append(h.calls, hostCallRecord{method: method, payload: append([]byte(nil), payload...)})
	h.mu.Unlock()
	if h.handle == nil {
		return nil, fmt.Errorf("no scripted host handler for %s", method)
	}
	return h.handle(method, payload)
}

func (h *recordingHost) records() []hostCallRecord {
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]hostCallRecord(nil), h.calls...)
}

func (h *recordingHost) countMethods(method string) int {
	h.mu.Lock()
	defer h.mu.Unlock()
	count := 0
	for _, record := range h.calls {
		if record.method == method {
			count++
		}
	}
	return count
}

func decodePayload(t *testing.T, payload []byte) map[string]any {
	t.Helper()
	var decoded map[string]any
	if err := json.Unmarshal(payload, &decoded); err != nil {
		t.Fatalf("decode host callback payload %s: %v", payload, err)
	}
	return decoded
}

func mustReceive(t *testing.T, chunks <-chan StreamChunk) (StreamChunk, bool) {
	t.Helper()
	select {
	case chunk, ok := <-chunks:
		return chunk, ok
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for stream chunk")
		return StreamChunk{}, false
	}
}

func drainChunks(t *testing.T, chunks <-chan StreamChunk) {
	t.Helper()
	drained := make(chan struct{})
	go func() {
		defer close(drained)
		for range chunks {
		}
	}()
	select {
	case <-drained:
	case <-time.After(2 * time.Second):
		t.Fatal("chunk channel did not terminate")
	}
}

func recordedPayloadField(t *testing.T, host *recordingHost, method, field string) any {
	t.Helper()
	for _, record := range host.records() {
		if record.method != method {
			continue
		}
		if value, ok := decodePayload(t, record.payload)[field]; ok {
			return value
		}
	}
	t.Fatalf("host callback %s was never invoked with %s", method, field)
	return nil
}

func TestHostBridgeDoStampsCallbackIDAndDecodesRawResult(t *testing.T) {
	host := &recordingHost{handle: func(method string, payload []byte) ([]byte, error) {
		if method != "host.http.do" {
			return nil, fmt.Errorf("unexpected host method %s", method)
		}
		request := decodePayload(t, payload)
		if request["host_callback_id"] != "cb-1" {
			return nil, fmt.Errorf("host_callback_id = %v, want cb-1", request["host_callback_id"])
		}
		if request["method"] != "POST" || request["url"] != "https://example.test/token" {
			return nil, fmt.Errorf("unexpected request fields: %v", request)
		}
		// Raw pluginapi.HTTPResponse bytes: untagged Go field names and a
		// base64 body. No RPC envelope wrapper.
		return []byte(`{"StatusCode":201,"Headers":{"X-Test":["v"]},"Body":"aGk="}`), nil
	}}
	bridge := NewHostBridge(host.call)

	result, err := bridge.Do(WithHostCallbackID(context.Background(), "cb-1"), "POST", "https://example.test/token", map[string][]string{"A": {"b"}}, []byte("body"))
	if err != nil {
		t.Fatalf("Do returned error: %v", err)
	}
	if result.StatusCode != 201 {
		t.Fatalf("StatusCode = %d, want 201", result.StatusCode)
	}
	if string(result.Body) != "hi" {
		t.Fatalf("Body = %q, want %q", result.Body, "hi")
	}
	if len(result.Headers["X-Test"]) != 1 || result.Headers["X-Test"][0] != "v" {
		t.Fatalf("Headers = %v, want X-Test: v", result.Headers)
	}
	if got := recordedPayloadField(t, host, "host.http.do", "host_callback_id"); got != "cb-1" {
		t.Fatalf("recorded host_callback_id = %v, want cb-1", got)
	}
}

func TestHostBridgeDoRejectsMissingCallbackID(t *testing.T) {
	host := &recordingHost{handle: func(string, []byte) ([]byte, error) {
		t.Error("host callback must not be invoked without a callback ID")
		return nil, nil
	}}
	bridge := NewHostBridge(host.call)

	_, err := bridge.Do(context.Background(), "POST", "https://example.test", nil, nil)
	if err == nil || !strings.Contains(err.Error(), "callback ID") {
		t.Fatalf("Do error = %v, want missing callback ID rejection", err)
	}
	if got := len(host.records()); got != 0 {
		t.Fatalf("host callbacks recorded = %d, want 0", got)
	}
}

func TestHostBridgeDoPropagatesCallbackFailure(t *testing.T) {
	host := &recordingHost{handle: func(string, []byte) ([]byte, error) {
		return nil, fmt.Errorf("upstream refused")
	}}
	bridge := NewHostBridge(host.call)

	_, err := bridge.Do(WithHostCallbackID(context.Background(), "cb-1"), "POST", "https://example.test", nil, nil)
	if err == nil || !strings.Contains(err.Error(), "upstream refused") {
		t.Fatalf("Do error = %v, want wrapped callback failure", err)
	}
}

func TestHostBridgeTwoSimultaneousContextsStayIsolated(t *testing.T) {
	host := &recordingHost{handle: func(method string, payload []byte) ([]byte, error) {
		if method != "host.http.do" {
			return nil, fmt.Errorf("unexpected host method %s", method)
		}
		request := decodePayload(t, payload)
		callbackID, _ := request["host_callback_id"].(string)
		body := base64.StdEncoding.EncodeToString([]byte("resp-" + callbackID))
		return []byte(fmt.Sprintf(`{"StatusCode":200,"Headers":{},"Body":%q}`, body)), nil
	}}
	bridge := NewHostBridge(host.call)

	var wg sync.WaitGroup
	bodies := make(chan string, 2)
	for _, id := range []string{"cb-a", "cb-b"} {
		wg.Add(1)
		go func(callbackID string) {
			defer wg.Done()
			result, err := bridge.Do(WithHostCallbackID(context.Background(), callbackID), "POST", "https://example.test", nil, nil)
			if err != nil {
				t.Errorf("Do(%s) returned error: %v", callbackID, err)
				return
			}
			bodies <- string(result.Body)
		}(id)
	}
	wg.Wait()
	close(bodies)

	seen := map[string]bool{}
	for body := range bodies {
		seen[body] = true
	}
	if !seen["resp-cb-a"] || !seen["resp-cb-b"] {
		t.Fatalf("bodies = %v, want one response per context", seen)
	}
}

func TestHostBridgeStreamDoneDeliversPayloadsThenCloses(t *testing.T) {
	var mu sync.Mutex
	reads := 0
	host := &recordingHost{handle: func(method string, payload []byte) ([]byte, error) {
		switch method {
		case "host.http.do_stream":
			request := decodePayload(t, payload)
			if request["host_callback_id"] != "cb-1" {
				return nil, fmt.Errorf("do_stream host_callback_id = %v, want cb-1", request["host_callback_id"])
			}
			return []byte(`{"status_code":200,"headers":{"Content-Type":["text/event-stream"]},"stream_id":"s-7"}`), nil
		case "host.http.stream_read":
			mu.Lock()
			reads++
			index := reads
			mu.Unlock()
			switch index {
			case 1:
				return []byte(`{"payload":"aGVsbG8="}`), nil
			case 2:
				return []byte(`{"payload":"d29ybGQ="}`), nil
			default:
				return []byte(`{"done":true}`), nil
			}
		case "host.http.stream_close":
			return []byte(`{}`), nil
		default:
			return nil, fmt.Errorf("unexpected host method %s", method)
		}
	}}
	bridge := NewHostBridge(host.call)

	result, err := bridge.DoStream(WithHostCallbackID(context.Background(), "cb-1"), "POST", "https://example.test/stream", nil, nil)
	if err != nil {
		t.Fatalf("DoStream returned error: %v", err)
	}
	if result.StatusCode != 200 {
		t.Fatalf("StatusCode = %d, want 200", result.StatusCode)
	}

	chunk, ok := mustReceive(t, result.Chunks)
	if !ok || string(chunk.Payload) != "hello" || chunk.Err != nil {
		t.Fatalf("first chunk = (%q, %v, ok=%v), want hello", chunk.Payload, chunk.Err, ok)
	}
	chunk, ok = mustReceive(t, result.Chunks)
	if !ok || string(chunk.Payload) != "world" || chunk.Err != nil {
		t.Fatalf("second chunk = (%q, %v, ok=%v), want world", chunk.Payload, chunk.Err, ok)
	}
	if _, ok := mustReceive(t, result.Chunks); ok {
		t.Fatal("chunk channel stayed open after done")
	}

	if got := host.countMethods("host.http.stream_close"); got != 1 {
		t.Fatalf("host.http.stream_close calls = %d, want 1", got)
	}
	if got := recordedPayloadField(t, host, "host.http.stream_close", "stream_id"); got != "s-7" {
		t.Fatalf("stream_close stream_id = %v, want s-7", got)
	}
}

func TestHostBridgeStreamErrorChunkFailsRelay(t *testing.T) {
	host := &recordingHost{handle: func(method string, payload []byte) ([]byte, error) {
		switch method {
		case "host.http.do_stream":
			return []byte(`{"status_code":200,"stream_id":"s-8"}`), nil
		case "host.http.stream_read":
			return []byte(`{"error":"upstream reset","done":true}`), nil
		case "host.http.stream_close":
			return []byte(`{}`), nil
		default:
			return nil, fmt.Errorf("unexpected host method %s", method)
		}
	}}
	bridge := NewHostBridge(host.call)

	result, err := bridge.DoStream(WithHostCallbackID(context.Background(), "cb-1"), "POST", "https://example.test/stream", nil, nil)
	if err != nil {
		t.Fatalf("DoStream returned error: %v", err)
	}

	chunk, ok := mustReceive(t, result.Chunks)
	if !ok || chunk.Err == nil || !strings.Contains(chunk.Err.Error(), "upstream reset") {
		t.Fatalf("chunk = (%q, %v, ok=%v), want upstream reset error", chunk.Payload, chunk.Err, ok)
	}
	if _, ok := mustReceive(t, result.Chunks); ok {
		t.Fatal("chunk channel stayed open after error")
	}
	if got := host.countMethods("host.http.stream_close"); got != 1 {
		t.Fatalf("host.http.stream_close calls = %d, want 1", got)
	}
}

func TestHostBridgeStreamNon2xxCallerClosesWithoutConsuming(t *testing.T) {
	host := &recordingHost{handle: func(method string, payload []byte) ([]byte, error) {
		switch method {
		case "host.http.do_stream":
			return []byte(`{"status_code":429,"stream_id":"s-9"}`), nil
		case "host.http.stream_read":
			return []byte(`{"payload":"dW5uZWNlc3Nhcnk="}`), nil
		case "host.http.stream_close":
			return []byte(`{}`), nil
		default:
			return nil, fmt.Errorf("unexpected host method %s", method)
		}
	}}
	bridge := NewHostBridge(host.call)

	result, err := bridge.DoStream(WithHostCallbackID(context.Background(), "cb-1"), "POST", "https://example.test/stream", nil, nil)
	if err != nil {
		t.Fatalf("DoStream returned error: %v", err)
	}
	if result.StatusCode != 429 {
		t.Fatalf("StatusCode = %d, want 429", result.StatusCode)
	}

	// The caller rejects the status and abandons the stream without reading.
	bridge.CloseStream(result)
	drainChunks(t, result.Chunks)

	if got := host.countMethods("host.http.stream_close"); got != 1 {
		t.Fatalf("host.http.stream_close calls = %d, want exactly 1", got)
	}
	if got := recordedPayloadField(t, host, "host.http.stream_close", "stream_id"); got != "s-9" {
		t.Fatalf("stream_close stream_id = %v, want s-9", got)
	}
}

func TestHostBridgeStreamHonorsContextCancellation(t *testing.T) {
	started := make(chan struct{})
	var once sync.Once
	release := make(chan struct{})
	var releaseOnce sync.Once
	host := &recordingHost{handle: func(method string, payload []byte) ([]byte, error) {
		switch method {
		case "host.http.do_stream":
			return []byte(`{"status_code":200,"stream_id":"s-10"}`), nil
		case "host.http.stream_read":
			once.Do(func() { close(started) })
			<-release
			return []byte(`{"payload":"bGF0ZQ=="}`), nil
		case "host.http.stream_close":
			releaseOnce.Do(func() { close(release) })
			return []byte(`{}`), nil
		default:
			return nil, fmt.Errorf("unexpected host method %s", method)
		}
	}}
	bridge := NewHostBridge(host.call)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	result, err := bridge.DoStream(WithHostCallbackID(ctx, "cb-1"), "POST", "https://example.test/stream", nil, nil)
	if err != nil {
		t.Fatalf("DoStream returned error: %v", err)
	}

	// Wait until the pump is blocked inside the first host read, then cancel.
	<-started
	cancel()
	// Only stream_close releases this fake blocked read. No external nudge:
	// local cancellation must reach the host before read can return.
	if _, ok := mustReceive(t, result.Chunks); ok {
		t.Fatal("cancelled read emitted a late chunk")
	}
	if got := host.countMethods("host.http.stream_close"); got != 1 {
		t.Fatalf("host.http.stream_close calls = %d, want 1", got)
	}
}

func TestHostBridgeCancelledBeforeDispatchMakesNoCallback(t *testing.T) {
	ctx, cancel := context.WithCancel(WithHostCallbackID(context.Background(), "cb-cancelled"))
	cancel()
	host := &recordingHost{}
	bridge := NewHostBridge(host.call)
	if _, err := bridge.Do(ctx, "POST", "https://example.test", nil, nil); !errors.Is(err, context.Canceled) {
		t.Fatalf("Do = %v", err)
	}
	if _, err := bridge.DoStream(ctx, "POST", "https://example.test", nil, nil); !errors.Is(err, context.Canceled) {
		t.Fatalf("DoStream = %v", err)
	}
	if len(host.records()) != 0 {
		t.Fatal("cancelled context dispatched")
	}
}

func TestHostBridgeStreamRejectsMissingCallbackID(t *testing.T) {
	host := &recordingHost{handle: func(string, []byte) ([]byte, error) {
		t.Error("host callback must not be invoked without a callback ID")
		return nil, nil
	}}
	bridge := NewHostBridge(host.call)

	_, err := bridge.DoStream(context.Background(), "POST", "https://example.test/stream", nil, nil)
	if err == nil || !strings.Contains(err.Error(), "callback ID") {
		t.Fatalf("DoStream error = %v, want missing callback ID rejection", err)
	}
	if got := len(host.records()); got != 0 {
		t.Fatalf("host callbacks recorded = %d, want 0", got)
	}
}

func TestHostBridgeStreamOpenFailurePropagates(t *testing.T) {
	host := &recordingHost{handle: func(method string, payload []byte) ([]byte, error) {
		if method == "host.http.do_stream" {
			return nil, fmt.Errorf("upstream connect refused")
		}
		t.Errorf("unexpected host method %s after failed open", method)
		return nil, fmt.Errorf("unexpected host method %s", method)
	}}
	bridge := NewHostBridge(host.call)

	_, err := bridge.DoStream(WithHostCallbackID(context.Background(), "cb-1"), "POST", "https://example.test/stream", nil, nil)
	if err == nil || !strings.Contains(err.Error(), "upstream connect refused") {
		t.Fatalf("DoStream error = %v, want wrapped open failure", err)
	}
	if got := host.countMethods("host.http.stream_close"); got != 0 {
		t.Fatalf("host.http.stream_close calls = %d, want 0 (no stream opened)", got)
	}
}

func TestHostBridgeStreamOpenWithoutStreamIDFails(t *testing.T) {
	host := &recordingHost{handle: func(method string, payload []byte) ([]byte, error) {
		switch method {
		case "host.http.do_stream":
			return []byte(`{"status_code":200}`), nil
		default:
			t.Errorf("unexpected host method %s", method)
			return nil, fmt.Errorf("unexpected host method %s", method)
		}
	}}
	bridge := NewHostBridge(host.call)

	_, err := bridge.DoStream(WithHostCallbackID(context.Background(), "cb-1"), "POST", "https://example.test/stream", nil, nil)
	if err == nil || !strings.Contains(err.Error(), "no stream id") {
		t.Fatalf("DoStream error = %v, want missing stream id rejection", err)
	}
	if got := host.countMethods("host.http.stream_read"); got != 0 {
		t.Fatalf("host.http.stream_read calls = %d, want 0", got)
	}
}

func TestHostBridgeStreamEmptyNonDoneReadFailsInsteadOfSpinning(t *testing.T) {
	host := &recordingHost{handle: func(method string, payload []byte) ([]byte, error) {
		switch method {
		case "host.http.do_stream":
			return []byte(`{"status_code":200,"stream_id":"s-11"}`), nil
		case "host.http.stream_read":
			return []byte(`{}`), nil
		case "host.http.stream_close":
			return []byte(`{}`), nil
		default:
			return nil, fmt.Errorf("unexpected host method %s", method)
		}
	}}
	bridge := NewHostBridge(host.call)

	result, err := bridge.DoStream(WithHostCallbackID(context.Background(), "cb-1"), "POST", "https://example.test/stream", nil, nil)
	if err != nil {
		t.Fatalf("DoStream returned error: %v", err)
	}

	chunk, ok := mustReceive(t, result.Chunks)
	if !ok || chunk.Err == nil || !strings.Contains(chunk.Err.Error(), "empty non-done") {
		t.Fatalf("chunk = (%q, %v, ok=%v), want empty non-done protocol error", chunk.Payload, chunk.Err, ok)
	}
	if _, ok := mustReceive(t, result.Chunks); ok {
		t.Fatal("chunk channel stayed open after protocol error")
	}
	if got := host.countMethods("host.http.stream_close"); got != 1 {
		t.Fatalf("host.http.stream_close calls = %d, want 1", got)
	}
}

func TestHostBridgeStreamCloseIsIdempotent(t *testing.T) {
	host := &recordingHost{handle: func(method string, payload []byte) ([]byte, error) {
		switch method {
		case "host.http.do_stream":
			return []byte(`{"status_code":200,"stream_id":"s-12"}`), nil
		case "host.http.stream_read":
			return []byte(`{"done":true}`), nil
		case "host.http.stream_close":
			return []byte(`{}`), nil
		default:
			return nil, fmt.Errorf("unexpected host method %s", method)
		}
	}}
	bridge := NewHostBridge(host.call)

	result, err := bridge.DoStream(WithHostCallbackID(context.Background(), "cb-1"), "POST", "https://example.test/stream", nil, nil)
	if err != nil {
		t.Fatalf("DoStream returned error: %v", err)
	}

	drainChunks(t, result.Chunks)
	result.Close()
	result.Close()
	bridge.CloseStream(result)

	if got := host.countMethods("host.http.stream_close"); got != 1 {
		t.Fatalf("host.http.stream_close calls = %d, want exactly 1", got)
	}
}

func TestHostBridgeCloseStreamToleratesZeroResult(t *testing.T) {
	host := &recordingHost{handle: func(string, []byte) ([]byte, error) {
		t.Error("host callback must not be invoked for a zero StreamResult")
		return nil, nil
	}}
	bridge := NewHostBridge(host.call)

	bridge.CloseStream(StreamResult{})
	if got := len(host.records()); got != 0 {
		t.Fatalf("host callbacks recorded = %d, want 0", got)
	}
}

func TestHostBridgeStreamCloseIgnoresCloseFailure(t *testing.T) {
	host := &recordingHost{handle: func(method string, payload []byte) ([]byte, error) {
		switch method {
		case "host.http.do_stream":
			return []byte(`{"status_code":200,"stream_id":"s-13"}`), nil
		case "host.http.stream_read":
			return []byte(`{"done":true}`), nil
		case "host.http.stream_close":
			return nil, fmt.Errorf("bridge already torn down")
		default:
			return nil, fmt.Errorf("unexpected host method %s", method)
		}
	}}
	bridge := NewHostBridge(host.call)

	result, err := bridge.DoStream(WithHostCallbackID(context.Background(), "cb-1"), "POST", "https://example.test/stream", nil, nil)
	if err != nil {
		t.Fatalf("DoStream returned error: %v", err)
	}
	drainChunks(t, result.Chunks)

	result.Close()
	if got := host.countMethods("host.http.stream_close"); got != 1 {
		t.Fatalf("host.http.stream_close calls = %d, want exactly 1 attempt", got)
	}
}
