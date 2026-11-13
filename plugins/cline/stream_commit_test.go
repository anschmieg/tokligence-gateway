package cline

import (
	"errors"
	"io"
	"strings"
	"testing"
)

type terminalReadError struct{}

func (terminalReadError) Read([]byte) (int, error) {
	return 0, errors.New("fixture late transport failure")
}

type payloadReadError struct{ data string }

func (r *payloadReadError) Read(p []byte) (int, error) {
	n := copy(p, r.data)
	r.data = r.data[n:]
	return n, errors.New("fixture payload plus failure")
}

func TestPumpHoldsToolsUntilTransportEOF(t *testing.T) {
	prefix := sseFrame(toolCallFrame) + sseFrame(stopFinishFrame) + doneMarker
	for name, reader := range map[string]io.Reader{
		"late_transport_error": io.MultiReader(strings.NewReader(prefix), terminalReadError{}),
		"late_data":            io.MultiReader(strings.NewReader(prefix), strings.NewReader(sseFrame(contentFrame))),
		"payload_and_error":    &payloadReadError{data: prefix},
	} {
		t.Run(name, func(t *testing.T) {
			bridge := &recordingBridge{}
			pumpUpstreamStream("s", &HostStreamResponse{StatusCode: 200, Body: io.NopCloser(reader)}, bridge)
			frames, errMsg, closes := bridge.snapshot()
			if len(frames) != 0 || errMsg == "" || closes != 1 {
				t.Fatalf("terminal committed before EOF: frames=%q error=%q closes=%d", frames, errMsg, closes)
			}
		})
	}
}

func TestPumpUsesHostSSEFraming(t *testing.T) {
	bridge := &recordingBridge{}
	pumpUpstreamStream("s", &HostStreamResponse{StatusCode: 200, Body: pipeBody(sseFrame(contentFrame) + sseFrame(toolCallFrame) + sseFrame(stopFinishFrame) + doneMarker)}, bridge)
	frames, errMsg, closes := bridge.snapshot()
	if errMsg != "" || closes != 1 || len(frames) != 3 {
		t.Fatalf("unexpected result: %q %q %d", frames, errMsg, closes)
	}
	for _, frame := range frames {
		if !strings.HasPrefix(string(frame), "data: {") || !strings.HasSuffix(string(frame), "\n\n") {
			t.Fatalf("not a host SSE frame: %q", frame)
		}
	}
}
