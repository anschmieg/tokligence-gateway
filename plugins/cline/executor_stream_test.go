package cline

import (
	"io"
	"strings"
	"sync"
	"testing"
)

// recordingBridge captures StreamBridge calls from the pump.
type recordingBridge struct {
	mu       sync.Mutex
	emitted  [][]byte
	closeErr string
	closes   int
}

func (b *recordingBridge) Emit(streamID string, payload []byte) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.emitted = append(b.emitted, append([]byte(nil), payload...))
	return nil
}

func (b *recordingBridge) Close(streamID string, errMsg string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.closes == 0 {
		b.closeErr = errMsg
	}
	b.closes++
}

// snapshot returns a stable copy of the recorded state.
func (b *recordingBridge) snapshot() ([][]byte, string, int) {
	b.mu.Lock()
	defer b.mu.Unlock()
	frames := make([][]byte, len(b.emitted))
	for i, frame := range b.emitted {
		frames[i] = append([]byte(nil), frame...)
	}
	return frames, b.closeErr, b.closes
}

func sseFrame(raw string) string {
	return "data: " + raw + "\n\n"
}

// pipeBody turns a script of wire bytes into an io.ReadCloser the pump can
// consume, mirroring the host stream body contract.
func pipeBody(wire string) io.ReadCloser {
	return io.NopCloser(strings.NewReader(wire))
}

const (
	contentFrame    = `{"choices":[{"index":0,"delta":{"content":"hello"}}]}`
	toolCallFrame   = `{"choices":[{"index":0,"delta":{"tool_calls":[{"id":"call_1","function":{"name":"get_weather","arguments":"{}"}}]}}]}`
	usageFrame      = `{"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":5,"total_tokens":8}}`
	stopFinishFrame = `{"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}`
	lengthFinishFrm = `{"choices":[{"index":0,"delta":{},"finish_reason":"length"}]}`
	filterFinishFrm = `{"choices":[{"index":0,"delta":{},"finish_reason":"content_filter"}]}`
	doneMarker      = "data: [DONE]\n\n"
)

// TestPumpFlushesAllFramesOnSuccessfulTerminal verifies that a complete,
// successful stream forwards every data frame — including tool-call frames —
// and closes the bridge exactly once without an error.
func TestPumpFlushesAllFramesOnSuccessfulTerminal(t *testing.T) {
	bridge := &recordingBridge{}
	upstream := &HostStreamResponse{
		StatusCode: 200,
		Body: pipeBody(
			sseFrame(contentFrame) +
				sseFrame(toolCallFrame) +
				sseFrame(usageFrame) +
				sseFrame(stopFinishFrame) +
				doneMarker),
	}
	pumpUpstreamStream("s-1", upstream, bridge)
	frames, closeErr, closes := bridge.snapshot()
	if closes != 1 {
		t.Fatalf("bridge closes = %d, want 1", closes)
	}
	if closeErr != "" {
		t.Fatalf("bridge close error = %q, want none", closeErr)
	}
	joined := ""
	for _, frame := range frames {
		joined += string(frame)
	}
	for _, want := range []string{contentFrame, toolCallFrame, usageFrame, `"finish_reason":"stop"`} {
		if !strings.Contains(joined, want) {
			t.Fatalf("emitted frames lost %q: %q", want, joined)
		}
	}
	if strings.Index(joined, toolCallFrame) > strings.Index(joined, `"finish_reason":"stop"`) {
		t.Fatal("finish frame overtook withheld tool call")
	}
}

// TestPumpWithholdsToolFramesOnLengthTerminal proves a length terminal never
// releases withheld tool calls: the bridge is closed with an error and the
// withheld frames are not emitted.
func TestPumpWithholdsToolFramesOnLengthTerminal(t *testing.T) {
	bridge := &recordingBridge{}
	upstream := &HostStreamResponse{
		StatusCode: 200,
		Body: pipeBody(
			sseFrame(toolCallFrame) +
				sseFrame(lengthFinishFrm) +
				doneMarker),
	}
	pumpUpstreamStream("s-1", upstream, bridge)
	frames, closeErr, closes := bridge.snapshot()
	if closes == 0 {
		t.Fatal("bridge never closed")
	}
	for _, frame := range frames {
		if strings.Contains(string(frame), "tool_calls") {
			t.Fatalf("withheld tool frame leaked to bridge: %s", frame)
		}
	}
	if closeErr == "" {
		t.Fatal("truncated tool stream must close the bridge with an error")
	}
}

// TestPumpFailsOnMalformedSSE proves a malformed frame fails the stream.
func TestPumpFailsOnMalformedSSE(t *testing.T) {
	bridge := &recordingBridge{}
	upstream := &HostStreamResponse{
		StatusCode: 200,
		Body:       pipeBody("data: {broken}\n\n" + doneMarker),
	}
	pumpUpstreamStream("s-1", upstream, bridge)
	if _, closeErr, closes := bridge.snapshot(); closes == 0 || closeErr == "" {
		t.Fatalf("malformed SSE must close the bridge with an error, got closes=%d err=%q", closes, closeErr)
	}
}

// TestPumpFailsOnTruncatedStream proves an EOF before any terminal event is
// never reported as success: Finish() must reject a stream that never saw
// [DONE].
func TestPumpFailsOnTruncatedStream(t *testing.T) {
	p := NewStreamParser()
	if _, err := p.Feed([]byte(sseFrame(contentFrame))); err != nil {
		t.Fatalf("feed: %v", err)
	}
	if err := p.Finish(); err == nil {
		t.Fatal("finish without [DONE] must fail: stream was truncated")
	}
}

// TestPumpForwardsReasoningAndUsageFrames proves reasoning (reasoning_content)
// and usage-only frames flow through unmodified.
func TestPumpForwardsReasoningAndUsageFrames(t *testing.T) {
	reasoning := `{"choices":[{"index":0,"delta":{"reasoning_content":"thinking..."}}]}`
	p := NewStreamParser()
	events, err := p.Feed([]byte(sseFrame(reasoning) + sseFrame(stopFinishFrame) + sseFrame(usageFrame) + doneMarker))
	if err != nil {
		t.Fatalf("feed: %v", err)
	}
	if err := p.Finish(); err != nil {
		t.Fatalf("finish: %v", err)
	}
	if len(events) != 4 {
		t.Fatalf("events = %d, want reasoning, finish, usage and DONE", len(events))
	}
	if !strings.Contains(string(events[0].Data), "reasoning_content") {
		t.Fatalf("reasoning frame lost: %s", events[0].Data)
	}
	if !strings.Contains(string(events[2].Data), "usage") {
		t.Fatalf("usage frame lost: %s", events[2].Data)
	}
}

// TestFrameCarriesToolCalls proves the withholding probe distinguishes
// tool-bearing frames from plain content and usage frames, and fails closed
// on unparsable input.
func TestFrameCarriesToolCalls(t *testing.T) {
	if !frameCarriesToolCalls([]byte(toolCallFrame)) {
		t.Fatal("tool-bearing frame not detected")
	}
	if frameCarriesToolCalls([]byte(contentFrame)) {
		t.Fatal("content frame flagged as tool-bearing")
	}
	if frameCarriesToolCalls([]byte(usageFrame)) {
		t.Fatal("usage frame flagged as tool-bearing")
	}
	if !frameCarriesToolCalls([]byte("{broken}")) {
		t.Fatal("unparsable frame must be withheld (fail closed)")
	}
}

// TestNonSuccessfulFinishReasonsPreserved proves the parser preserves
// length/content_filter/tool_calls terminal reasons.
func TestNonSuccessfulFinishReasonsPreserved(t *testing.T) {
	for _, reason := range []string{"length", "content_filter", "tool_calls"} {
		p := NewStreamParser()
		wire := sseFrame(strings.ReplaceAll(stopFinishFrame, `"stop"`, `"`+reason+`"`)) + doneMarker
		events, err := p.Feed([]byte(wire))
		if err != nil {
			t.Fatalf("reason %s: feed: %v", reason, err)
		}
		last := events[len(events)-1]
		if last.FinishReason != reason {
			t.Fatalf("reason %s: parser reported %q", reason, last.FinishReason)
		}
		if last.Successful && reason != "tool_calls" {
			t.Fatalf("reason %s must not be successful", reason)
		}
	}
}
