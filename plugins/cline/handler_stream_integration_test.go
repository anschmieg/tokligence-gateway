package cline

import (
	"io"
	"strings"
	"testing"
)

// failingReader is an io.ReadCloser whose Read returns a scripted error,
// simulating a mid-stream upstream failure inside the host stream body.
type failingReader struct {
	err error
}

func (f *failingReader) Read([]byte) (int, error) { return 0, f.err }
func (f *failingReader) Close() error             { return nil }

// TestHandleMethodExecutorStreamFailsClosedWithoutDeps proves the RPC method
// never fabricates a completion when the streaming collaborators are absent.
func TestHandleMethodExecutorStreamFailsClosedWithoutDeps(t *testing.T) {
	handler := newConfiguredHandler(t, nil)
	request := mustMarshal(t, ExecutorStreamRequest{
		ExecutorRequest: ExecutorRequest{
			AuthID:       ProviderKey,
			AuthProvider: ProviderKey,
			Model:        "cline/gpt-x",
			Stream:       true,
		},
		StreamID: "host-stream-1",
	})
	raw, err := handler.HandleMethod("executor.execute_stream", request)
	if err == nil {
		t.Fatal("expected fail-closed error without stream deps")
	}
	if len(raw) != 0 {
		t.Fatalf("fail-closed must not return a payload, got %d bytes", len(raw))
	}
	if !strings.Contains(err.Error(), "streaming transport is unavailable") {
		t.Fatalf("error = %v, want streaming transport unavailable", err)
	}
}

// TestHandleMethodExecutorStreamRejectsNonStreamRequest proves stream=false is
// rejected before any upstream interaction.
func TestHandleMethodExecutorStreamRejectsNonStreamRequest(t *testing.T) {
	handler := newConfiguredHandler(t, nil)
	request := mustMarshal(t, ExecutorStreamRequest{
		ExecutorRequest: ExecutorRequest{
			AuthID:       ProviderKey,
			AuthProvider: ProviderKey,
			Model:        "cline/gpt-x",
			Stream:       false,
		},
		StreamID: "host-stream-1",
	})
	if _, err := handler.HandleMethod("executor.execute_stream", request); err == nil {
		t.Fatal("stream=false must be rejected")
	}
}

// TestHandleMethodExecutorStreamRejectsUnregisteredModel proves the catalog
// gate applies to the streaming path.
func TestHandleMethodExecutorStreamRejectsUnregisteredModel(t *testing.T) {
	handler := newConfiguredHandler(t, nil)
	request := mustMarshal(t, ExecutorStreamRequest{
		ExecutorRequest: ExecutorRequest{
			AuthID:       ProviderKey,
			AuthProvider: ProviderKey,
			Model:        "cline/not-in-catalog",
			Stream:       true,
		},
		StreamID: "host-stream-1",
	})
	if _, err := handler.HandleMethod("executor.execute_stream", request); err == nil {
		t.Fatal("unregistered model must be rejected")
	}
}

// TestPumpClosesBridgeOnUpstreamReadError proves a mid-stream read failure
// closes the bridge with an error and never emits withheld tool calls.
func TestPumpClosesBridgeOnUpstreamReadError(t *testing.T) {
	bridge := &recordingBridge{}
	upstream := &HostStreamResponse{
		StatusCode: 200,
		Body: io.NopCloser(io.MultiReader(
			strings.NewReader(sseFrame(contentFrame)),
			&failingReader{err: io.ErrUnexpectedEOF},
		)),
	}
	pumpUpstreamStream("s-err", upstream, bridge)
	frames, closeErr, closes := bridge.snapshot()
	if closes == 0 {
		t.Fatal("bridge never closed after read failure")
	}
	if closeErr == "" {
		t.Fatal("read failure must close the bridge with an error message")
	}
	for _, frame := range frames {
		if strings.Contains(string(frame), "tool_calls") {
			t.Fatalf("tool frame leaked after read failure: %s", frame)
		}
	}
}
