package cline

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
)

// StreamBridge delivers validated data frames to the host stream bridge for
// one executor.execute_stream call. The production implementation issues
// host.stream.emit / host.stream.close RPCs; tests provide fixtures.
type StreamBridge interface {
	// Emit forwards one complete upstream data frame. An error aborts the
	// pump and closes the upstream stream.
	Emit(streamID string, payload []byte) error
	// Close terminates the host stream exactly once, with an error message
	// when the stream failed. An empty message is a successful terminal.
	Close(streamID string, errMsg string)
}

// StreamDeps carries the injected streaming collaborators. The cgo entry
// point wires the real host-RPC implementation; tests inject fixtures.
type StreamDeps struct {
	// Client issues the upstream streaming HTTP call through
	// host.http.do_stream / stream_read / stream_close.
	Client *HostStreamClient
	// Bridge forwards validated frames to the host stream bridge.
	Bridge StreamBridge
}

// maxWithheldToolBytes bounds the tool-bearing frames withheld while waiting
// for a successful terminal. Overflow fails the stream instead of growing
// unbounded or flushing unvalidated tool calls.
const maxWithheldToolBytes = 4 << 20

// ExecutorStreamRequest is the executor.execute_stream request: the standard
// executor request plus the host-allocated stream bridge id. StreamID is the
// exact id from the host's stream bridge allocation (the host validates it
// per emit), never a plugin-chosen value.
type ExecutorStreamRequest struct {
	ExecutorRequest
	StreamID string `json:"stream_id,omitempty"`
}

// ExecutorStreamResponse is the synchronous executor.execute_stream result.
// Empty means async: chunks flow through host.stream.emit after the RPC
// returns, and the host keeps the callback context alive until the stream
// closes.
type ExecutorStreamResponse struct {
	Headers map[string][]string `json:"headers,omitempty"`
}

// handleExecuteStream serves executor.execute_stream. It validates the
// request fail-closed, forces stream:true on the upstream chat body, opens
// the upstream SSE stream through the injected HostStreamClient, and starts
// a background pump that feeds the SSE parser incrementally, forwards
// validated data frames to the host bridge, and closes the host stream
// exactly once with the terminal outcome.
func (h *Handler) handleExecuteStream(request []byte) ([]byte, error) {
	var req ExecutorStreamRequest
	if err := decodeInto(request, &req); err != nil {
		return nil, err
	}
	if h.streamDeps == nil || h.streamDeps.Client == nil || h.streamDeps.Bridge == nil {
		// Fail closed: without the injected streaming collaborators no
		// upstream stream is possible and no frame may be fabricated.
		return nil, withStatus(503, fmt.Errorf("cline streaming transport is unavailable"))
	}
	if !req.Stream {
		return nil, withStatus(400, fmt.Errorf("cline executor.execute_stream requires stream=true"))
	}
	if h.catalog == nil {
		return nil, fmt.Errorf("cline plugin is not configured")
	}
	if !h.catalog.Contains(req.Model) {
		return nil, withStatus(404, fmt.Errorf("cline model %q is not registered", req.Model))
	}
	storage, err := ParseStorage(req.StorageJSON)
	if err != nil {
		return nil, withStatus(401, fmt.Errorf("cline credential is unavailable: %v", err))
	}
	translated, _, err := TranslateChatRequest(req.Model, req.Payload)
	if err != nil {
		return nil, withStatus(400, err)
	}
	body, err := forceStreamInBody(translated)
	if err != nil {
		return nil, withStatus(400, err)
	}
	headers := RequestHeaders("")
	headers["Authorization"] = []string{AuthorizationHeader(storage.AccessToken)}

	streamID := strings.TrimSpace(req.StreamID)
	if streamID == "" {
		return nil, withStatus(400, fmt.Errorf("cline executor stream requires a host stream id"))
	}

	upstream, err := h.streamDeps.Client.DoStream(HostStreamRequest{
		HostCallbackID: req.HostCallbackID,
		Method:         "POST",
		URL:            h.apiBaseURL + "/api/v1/chat/completions",
		Headers:        headers,
		Body:           body,
	})
	if err != nil {
		var statusErr *UpstreamStatusError
		if errors.As(err, &statusErr) {
			return nil, withStatus(classifyStreamStatus(statusErr.StatusCode), fmt.Errorf("cline upstream failed: %s", statusErr.Message))
		}
		return nil, withStatus(502, fmt.Errorf("cline upstream stream failed: %v", err))
	}

	go pumpUpstreamStream(streamID, upstream, h.streamDeps.Bridge)
	return okEnvelope(ExecutorStreamResponse{})
}

// classifyStreamStatus maps an upstream rejection status onto the error
// envelope status. Statuses outside the client-error/upstream-error range
// surface as 502.
func classifyStreamStatus(status int) int {
	if status < 400 || status > 599 {
		return 502
	}
	return status
}

// forceStreamInBody sets stream=true in the translated upstream chat body.
// TranslateChatRequest decodes and remarshals the payload, so the assertion
// is a field set on a JSON object, never a string splice.
func forceStreamInBody(body []byte) ([]byte, error) {
	var payload map[string]any
	if err := json.Unmarshal(body, &payload); err != nil {
		return nil, fmt.Errorf("cline translated request body is not a JSON object: %w", err)
	}
	if payload == nil {
		payload = map[string]any{}
	}
	payload["stream"] = true
	encoded, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("cline request stream assertion failed: %w", err)
	}
	return encoded, nil
}

// pumpUpstreamStream reads the upstream SSE body incrementally, validates
// frames with the StreamParser, and forwards data frames to the host bridge.
//
// Contract enforced here:
//   - tool-bearing frames are withheld until a successful terminal
//     (stop/tool_calls) plus transport EOF validates the stream; on length/content_filter/
//     error/truncation the withheld calls are never released and the
//     terminal reason is preserved in the close error
//   - the [DONE] SSE marker is parser-internal: it is never emitted as a
//     data frame; the host's SSE writers add the terminal framing
//   - one upstream close (HostStreamBody's once-guard) and one host bridge
//     close per stream
//   - cancellation on emit failure: the upstream body is closed, which
//     aborts the host HTTP stream read
func pumpUpstreamStream(streamID string, upstream *HostStreamResponse, bridge StreamBridge) {
	parser := NewStreamParser()
	var withheld [][]byte
	withheldBytes := 0
	// closeUpstream releases the host HTTP stream exactly once (the body's
	// sync.Once makes repeated calls safe) and cancels any in-flight read.
	closeUpstream := func() { _ = upstream.Body.Close() }
	fail := func(errMsg string) {
		closeUpstream()
		bridge.Close(streamID, errMsg)
	}

	readBuf := make([]byte, 32<<10)
	for {
		n, errRead := upstream.Body.Read(readBuf)
		if n > 0 {
			events, errFeed := parser.Feed(readBuf[:n])
			if errFeed != nil {
				fail(streamFailureMessage(errFeed, ""))
				return
			}
			for _, event := range events {
				if event.Done {
					if !event.Successful {
						// length/content_filter and similar terminals are real
						// upstream outcomes but not successful completions;
						// withhold the buffered tool calls and report the
						// terminal reason.
						fail(fmt.Sprintf("cline upstream stream finished with %q", event.FinishReason))
						return
					}
					// DONE is provisional until transport EOF. Later bytes or a
					// read failure must never commit executable calls.
					continue
				}
				if len(event.Data) == 0 {
					continue
				}
				if len(withheld) == 0 && event.FinishReason == "" && !frameCarriesToolCalls(event.Data) {
					// Content/reasoning/usage frames flow through immediately;
					// they carry nothing executable.
					if errEmit := bridge.Emit(streamID, sseDataFrame(event.Data)); errEmit != nil {
						fail(fmt.Sprintf("cline stream emit failed: %v", errEmit))
						return
					}
					continue
				}
				// Once a tool frame is held, retain subsequent frames in order.
				// In particular, finish/usage must not overtake the tool call.
				withheld = append(withheld, event.Data)
				withheldBytes += len(event.Data)
				if withheldBytes > maxWithheldToolBytes {
					fail("cline stream withheld tool frames exceed limit")
					return
				}
			}
		}
		if errRead == io.EOF {
			// Only real EOF commits held tools and terminal frames.
			if errFinish := parser.Finish(); errFinish != nil {
				fail(streamFailureMessage(errFinish, ""))
				return
			}
			for _, frame := range withheld {
				if errEmit := bridge.Emit(streamID, sseDataFrame(frame)); errEmit != nil {
					fail(fmt.Sprintf("cline stream emit failed: %v", errEmit))
					return
				}
			}
			closeUpstream()
			bridge.Close(streamID, "")
			return
		}
		if errRead != nil {
			fail(streamFailureMessage(errRead, ""))
			return
		}
	}
}

// streamFailureMessage renders a parser or read failure for the host bridge
// close. It never fabricates a finish reason.
func streamFailureMessage(err error, finishReason string) string {
	message := "cline upstream stream failed"
	if err != nil {
		message = fmt.Sprintf("cline upstream stream failed: %v", err)
	}
	if finishReason != "" {
		message = fmt.Sprintf("%s (finish_reason %q)", message, finishReason)
	}
	return message
}

// frameCarriesToolCalls reports whether a chat-completions data frame
// contains tool-call entries, which must be withheld until the terminal is
// validated. Content, reasoning, and usage-only frames are never withheld.
func frameCarriesToolCalls(frame []byte) bool {
	var probe struct {
		Choices []struct {
			Delta struct {
				ToolCalls []any `json:"tool_calls"`
			} `json:"delta"`
			Message struct {
				ToolCalls []any `json:"tool_calls"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(frame, &probe); err != nil {
		// An unparsable frame cannot be proven tool-free; withholding it is
		// the safe direction.
		return true
	}
	for _, choice := range probe.Choices {
		if len(choice.Delta.ToolCalls) > 0 || len(choice.Message.ToolCalls) > 0 {
			return true
		}
	}
	return false
}

// The pinned host translators consume complete SSE data frames, not bare JSON.
func sseDataFrame(data []byte) []byte {
	frame := make([]byte, 0, len(data)+8)
	frame = append(frame, "data: "...)
	frame = append(frame, data...)
	return append(frame, '\n', '\n')
}
