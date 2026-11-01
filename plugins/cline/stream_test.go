package cline

import (
	"strings"
	"testing"
)

const finishFrame = "data: {\"choices\":[{\"index\":0,\"finish_reason\":\"stop\"}]}\n\n"
const doneFrame = "data: [DONE]\n\n"

func TestStreamChunkBoundariesAndRawReasoning(t *testing.T) {
	raw := `{"choices":[{"index":0,"delta":{"content":"DONE inside content","reasoning_content":"fixture"}}]}`
	wire := ": comment\r\nevent: message\r\ndata: " + raw + "\r\n\r\n" + finishFrame + "data: {\"choices\":[],\"usage\":{\"total_tokens\":7}}\n\n" + doneFrame
	for split := 0; split <= len(wire); split++ {
		p := NewStreamParser()
		a, err := p.Feed([]byte(wire[:split]))
		if err != nil {
			t.Fatal(split, err)
		}
		b, err := p.Feed([]byte(wire[split:]))
		if err != nil {
			t.Fatal(split, err)
		}
		events := append(a, b...)
		if len(events) != 4 || string(events[0].Data) != raw || !events[3].Done || !events[3].Successful {
			t.Fatalf("split %d: wrong events", split)
		}
		if err := p.Finish(); err != nil {
			t.Fatal(err)
		}
	}
}

func TestStreamMultilineData(t *testing.T) {
	p := NewStreamParser()
	events, err := p.Feed([]byte("data: {\n" + "data: \"choices\":[{\"delta\":{}}]}\n\n"))
	if err != nil || len(events) != 1 || !strings.Contains(string(events[0].Data), "\n") {
		t.Fatalf("multiline: %v", err)
	}
}

func TestStreamRejectsMalformedTerminalAndTruncation(t *testing.T) {
	cases := []string{
		"data: {broken}\n\n", "data: {\"error\":{\"message\":\"fixture\"}}\n\n",
		doneFrame, finishFrame, "data: {\"choices\":[{}]}",
		finishFrame + doneFrame + "data: {}\n\n",
		finishFrame + "data: {\"choices\":[{\"delta\":{\"content\":\"late\"}}]}\n\n",
	}
	for i, wire := range cases {
		p := NewStreamParser()
		_, err := p.Feed([]byte(wire))
		if err == nil {
			err = p.Finish()
		}
		if err == nil {
			t.Fatalf("case %d accepted", i)
		}
		if _, again := p.Feed([]byte("data: {}\n\n")); again == nil {
			t.Fatalf("case %d not sticky", i)
		}
	}
}

func TestStreamNonSuccessfulFinishPreserved(t *testing.T) {
	for _, reason := range []string{"length", "content_filter", "tool_calls"} {
		p := NewStreamParser()
		wire := strings.ReplaceAll(finishFrame, "stop", reason) + doneFrame
		events, err := p.Feed([]byte(wire))
		if err != nil {
			t.Fatal(err)
		}
		last := events[len(events)-1]
		if last.FinishReason != reason || last.Successful != (reason == "tool_calls") {
			t.Fatal("finish semantics changed")
		}
	}
}

func TestStreamBoundsAccumulatedFrame(t *testing.T) {
	p := NewStreamParserWithSize(32)
	if _, err := p.Feed([]byte("data: " + strings.Repeat("x", 16) + "\n")); err != nil {
		t.Fatal(err)
	}
	if _, err := p.Feed([]byte("data: " + strings.Repeat("x", 16) + "\n")); err == nil {
		t.Fatal("oversized multiline frame accepted")
	}
}
