package opencode

import (
	"encoding/json"
	"fmt"
	"strings"
	"sync/atomic"
	"testing"
)

const fixtureTextSSE = "data: {\"id\":\"fixture\",\"model\":\"beam-free\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"hi\"}}]}\n\ndata: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n"

func sseFrame(value any) string {
	raw, _ := json.Marshal(value)
	return "data: " + string(raw) + "\n\n"
}
func toolResponseSSE(reason string) string {
	return `data: {"id":"fixture-tools","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call-a","type":"function","function":{"name":"Read","arguments":"{\"x\":"}},{"index":1,"id":"call-b","type":"function","function":{"name":"Read","arguments":"{\"y\":"}}]}}]}` + "\n\n" +
		`data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":1,"function":{"arguments":"2}"}},{"index":0,"function":{"arguments":"1}"}}]}}]}` + "\n\n" +
		fmt.Sprintf(`data: {"choices":[{"index":0,"delta":{},"finish_reason":%q}]}`, reason) + "\n\n" +
		`data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":4,"total_tokens":7}}` + "\n\ndata: [DONE]\n\n"
}

func runResponseRelay(body string) ([][]byte, error) {
	chunks := make(chan StreamChunk, 1)
	chunks <- StreamChunk{Payload: []byte(body)}
	close(chunks)
	var frames [][]byte
	err := RelayOpenCodeSSE(chunks, nil, func(frame []byte) error { frames = append(frames, frame); return nil })
	return frames, err
}

func TestResponseReasoningAndParallelTools(t *testing.T) {
	body := sseFrame(map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"role": "assistant", "reasoning_content": "think 🦉\n", "content": nil}}}}) +
		sseFrame(map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"reasoning_content": "then act", "content": "hello"}}}}) + toolResponseSSE("tool_calls")
	chunks := make(chan StreamChunk)
	go func() {
		defer close(chunks)
		for _, b := range []byte(body) {
			chunks <- StreamChunk{Payload: []byte{b}}
		}
	}()
	var frames [][]byte
	if err := RelayOpenCodeSSE(chunks, nil, func(frame []byte) error { frames = append(frames, frame); return nil }); err != nil {
		t.Fatal(err)
	}
	if len(frames) != 6 {
		t.Fatalf("lost frames: %d", len(frames))
	}
	for _, frame := range frames {
		if !strings.HasPrefix(string(frame), "data: {") || !strings.HasSuffix(string(frame), "\n\n") {
			t.Fatalf("incorrect host frame %q", frame)
		}
	}
	raw, err := CollectOpenCodeSSE([]byte(body), nil)
	if err != nil {
		t.Fatal(err)
	}
	var out struct {
		Object  string
		Choices []struct {
			Message struct {
				Role, Content string
				Reasoning     string `json:"reasoning_content"`
				Tools         []struct {
					ID       string
					Function struct{ Name, Arguments string }
				} `json:"tool_calls"`
			}
		}
		Usage struct {
			Total int `json:"total_tokens"`
		}
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatal(err)
	}
	m := out.Choices[0].Message
	if out.Object != "chat.completion" || m.Role != "assistant" || m.Content != "hello" || m.Reasoning != "think 🦉\nthen act" || len(m.Tools) != 2 || m.Tools[0].ID != "call-a" || m.Tools[0].Function.Arguments != "{\"x\":1}" || m.Tools[1].Function.Arguments != "{\"y\":2}" || out.Usage.Total != 7 {
		t.Fatalf("incorrect aggregation: %s", raw)
	}
}

func TestResponseToolsCommitOnlyAtTransportEOF(t *testing.T) {
	for _, lateError := range []bool{false, true} {
		chunks := make(chan StreamChunk)
		var emitted atomic.Int64
		done := make(chan error, 1)
		go func() { done <- RelayOpenCodeSSE(chunks, nil, func([]byte) error { emitted.Add(1); return nil }) }()
		chunks <- StreamChunk{Payload: []byte(toolResponseSSE("tool_calls"))}
		chunks <- StreamChunk{} // parser processed DONE and is waiting for EOF
		if emitted.Load() != 0 {
			t.Fatal("tools released before EOF")
		}
		if lateError {
			chunks <- StreamChunk{Err: fmt.Errorf("late upstream reset")}
		}
		close(chunks)
		err := <-done
		if lateError {
			if err == nil || emitted.Load() != 0 {
				t.Fatal("late failure released tool calls")
			}
		} else if err != nil || emitted.Load() != 4 {
			t.Fatalf("successful terminal: %v frames%d", err, emitted.Load())
		}
	}
}

func TestResponseTerminalFailuresWithholdTools(t *testing.T) {
	for _, reason := range []string{"length", "content_filter"} {
		body := toolResponseSSE(reason)
		frames, err := runResponseRelay(body)
		if err == nil || !strings.Contains(err.Error(), reason) || len(frames) != 0 {
			t.Fatalf("%s: %v frames%d", reason, err, len(frames))
		}
		if _, err := CollectOpenCodeSSE([]byte(body), nil); err == nil || !strings.Contains(err.Error(), reason) {
			t.Fatalf("buffered %s: %v", reason, err)
		}
	}
	for _, body := range []string{
		strings.TrimSuffix(toolResponseSSE("tool_calls"), "data: [DONE]\n\n"),
		toolResponseSSE("tool_calls") + "data: {}\n\n",
		strings.Replace(toolResponseSSE("tool_calls"), `"arguments":"1}"`, `"arguments":"false"`, 1),
	} {
		frames, err := runResponseRelay(body)
		if err == nil || len(frames) != 0 {
			t.Fatalf("failed terminal released %d frames, err%v", len(frames), err)
		}
	}
}

func TestResponseRejectsMalformedUnsupportedAndQuota(t *testing.T) {
	for _, body := range []string{
		"data: null\n\n", "data: []\n\n", "data: {broken}\n\n", "data: [DONE]\n\n",
		`data: {"choices":[{"index":1,"delta":{}}]}` + "\n\n",
		`data: {"choices":[{"index":0,"delta":{}},{"index":1,"delta":{}}]}` + "\n\n",
		`data: {"choices":[{"index":0,"delta":{"content":[{"type":"image"}]}}]}` + "\n\n",
		`data: {"choices":[{"index":0,"delta":{"reasoning_details":[]}}]}` + "\n\n",
	} {
		if _, err := CollectOpenCodeSSE([]byte(body), nil); err == nil {
			t.Errorf("accepted %q", body)
		}
	}
	body := `data: {"error":{"type":"FreeUsageLimitError","status":429}}` + "\n\n"
	for _, stream := range []bool{false, true} {
		var err error
		if stream {
			_, err = runResponseRelay(body)
		} else {
			_, err = CollectOpenCodeSSE([]byte(body), map[string][]string{"retry-after": {"120"}})
		}
		if statusOf(err) != 429 {
			t.Fatalf("embedded quota status lost: %v", err)
		}
	}
}

func TestResponseMultilineAndLimits(t *testing.T) {
	body := ": keepalive\r\ndata: {\"choices\":[\r\ndata: {\"index\":0,\"delta\":{\"content\":\"hi\"}}]}\r\n\r\n" + strings.SplitN(fixtureTextSSE, "\n\n", 2)[1] + " \n"
	frames, err := runResponseRelay(body)
	if err != nil || len(frames) != 2 {
		t.Fatalf("multiline: %v frames%d", err, len(frames))
	}
	if _, err := CollectOpenCodeSSE([]byte(strings.Repeat("x", responseTotalLimit+1)), nil); err == nil {
		t.Fatal("unbounded total")
	}
	if _, err := CollectOpenCodeSSE([]byte("data: "+strings.Repeat("x", responseFrameLimit)), nil); err == nil {
		t.Fatal("unbounded frame")
	}
	var held string
	for i := 0; i < 6; i++ {
		held += sseFrame(map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"tool_calls": []any{map[string]any{"index": 0, "function": map[string]string{"arguments": strings.Repeat("x", 800000)}}}}}}})
	}
	if frames, err := runResponseRelay(held); err == nil || !strings.Contains(err.Error(), "withheld") || len(frames) != 0 {
		t.Fatalf("withheld bound: %v", err)
	}
}

func TestHandlerValidatesBufferedAndStreamingToolOutcomes(t *testing.T) {
	for _, stream := range []bool{false, true} {
		for _, reason := range []string{"tool_calls", "length", "content_filter"} {
			t.Run(fmt.Sprintf("stream=%v/%s", stream, reason), func(t *testing.T) {
				body := toolResponseSSE(reason)
				chunks := make(chan StreamChunk, 1)
				chunks <- StreamChunk{Payload: []byte(body)}
				close(chunks)
				transport := &fakeTransport{doResult: HTTPResult{StatusCode: 200, Body: []byte(body)}, streamResult: StreamResult{StatusCode: 200, Chunks: chunks}}
				h := newTestHandler(t, transport)
				if !stream {
					response, err := h.HandleMethod("executor.execute", configLifecycleRequest(false))
					if reason == "tool_calls" {
						if err != nil || !strings.Contains(string(decodeOKEnvelope(t, response)), "Payload") {
							t.Fatalf("buffered success %v", err)
						}
					} else if err == nil || !strings.Contains(err.Error(), reason) {
						t.Fatalf("buffered failure %v", err)
					}
					return
				}
				var frames [][]byte
				done := make(chan error, 1)
				StreamEmitter = func(_ string, frame []byte) error { frames = append(frames, frame); return nil }
				StreamCloser = func(_ string, err error) { done <- err }
				defer func() { StreamEmitter = nil; StreamCloser = nil }()
				if _, err := h.HandleMethod("executor.execute_stream", configLifecycleRequest(true)); err != nil {
					t.Fatal(err)
				}
				err := <-done
				waitFor(t, func() bool { return h.activeStreams.Load() == 0 })
				if reason == "tool_calls" {
					if err != nil || len(frames) != 4 {
						t.Fatalf("stream success %v frames%d", err, len(frames))
					}
				} else if err == nil || len(frames) != 0 || !strings.Contains(err.Error(), reason) {
					t.Fatalf("stream failure %v frames%d", err, len(frames))
				}
				if transport.closed != 1 {
					t.Fatal("upstream stream not closed exactly once")
				}
			})
		}
	}
}

func TestEmbeddedQuotaPreservesHostHeaderCasingAndRequestID(t *testing.T) {
	body := []byte(`data: {"error":{"type":"FreeUsageLimitError","status":429}}` + "\n\n")
	_, err := CollectOpenCodeSSE(body, map[string][]string{"X-Opencode-Log-Id": {"fixture-request-id"}, "Retry-After": {"120"}})
	se, ok := AsStatusError(err)
	if !ok || se.Status() != 429 || se.RetryAfterSeconds() != 120 || !strings.Contains(err.Error(), "fixture-request-id") {
		t.Fatalf("lost quota diagnostics: %v", err)
	}
}
