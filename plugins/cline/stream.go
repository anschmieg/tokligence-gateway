package cline

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
)

// StreamEvent preserves upstream data. Tool deltas are proposals only: the
// bridge must withhold executable calls until Done && Successful.
type StreamEvent struct {
	Data         []byte
	Done         bool
	Successful   bool
	FinishReason string
}

// StreamParser validates a single-choice Chat Completions SSE response.
// Instances belong to one request. It never executes tools or repairs history.
type StreamParser struct {
	line, frame   []byte
	limit         int
	hasData, done bool
	finish        string
	failure       error
}

func NewStreamParser() *StreamParser { return NewStreamParserWithSize(1 << 20) }
func NewStreamParserWithSize(limit int) *StreamParser {
	if limit <= 0 {
		limit = 1 << 20
	}
	return &StreamParser{limit: limit}
}

func (p *StreamParser) fail(message string) error {
	p.failure = errors.New(message)
	return p.failure
}

// Feed accepts arbitrary network chunks. Errors are sticky and no events
// from a failing Feed are returned. The caller must treat any error as failure.
func (p *StreamParser) Feed(chunk []byte) ([]StreamEvent, error) {
	if p.failure != nil {
		return nil, p.failure
	}
	var events []StreamEvent
	for _, b := range chunk {
		if p.done {
			return nil, p.fail("data after SSE terminal event")
		}
		if b != '\n' {
			p.line = append(p.line, b)
			if len(p.line)+len(p.frame) > p.limit {
				return nil, p.fail("SSE frame exceeds limit")
			}
			continue
		}
		line := bytes.TrimSuffix(p.line, []byte{'\r'})
		p.line = nil
		if len(line) == 0 {
			if !p.hasData {
				continue
			}
			event, err := p.decode(p.frame)
			p.frame, p.hasData = nil, false
			if err != nil {
				return nil, err
			}
			events = append(events, event)
			continue
		}
		if line[0] == ':' {
			continue
		}
		field, value, found := bytes.Cut(line, []byte{':'})
		if !found {
			value = nil
		}
		value = bytes.TrimPrefix(value, []byte{' '})
		if string(field) != "data" {
			continue
		} // SSE event/id/retry metadata.
		if p.hasData {
			p.frame = append(p.frame, '\n')
		}
		p.frame = append(p.frame, value...)
		p.hasData = true
		if len(p.frame) > p.limit {
			return nil, p.fail("SSE frame exceeds limit")
		}
	}
	return events, nil
}

func (p *StreamParser) decode(data []byte) (StreamEvent, error) {
	if bytes.Equal(data, []byte("[DONE]")) {
		if p.finish == "" {
			return StreamEvent{}, p.fail("SSE terminal event lacks finish reason")
		}
		p.done = true
		return StreamEvent{Done: true, FinishReason: p.finish, Successful: p.finish == "stop" || p.finish == "tool_calls"}, nil
	}
	var body struct {
		Error   json.RawMessage `json:"error"`
		Choices []struct {
			Index        int     `json:"index"`
			FinishReason *string `json:"finish_reason"`
		} `json:"choices"`
		Usage json.RawMessage `json:"usage"`
	}
	if err := json.Unmarshal(data, &body); err != nil {
		return StreamEvent{}, p.fail("invalid SSE JSON object")
	}
	if len(body.Error) > 0 && !bytes.Equal(body.Error, []byte("null")) {
		return StreamEvent{}, p.fail("upstream error in SSE stream")
	}
	if p.finish != "" && len(body.Choices) > 0 {
		return StreamEvent{}, p.fail("choice data after finish reason")
	}
	if len(body.Choices) > 1 {
		return StreamEvent{}, p.fail("multiple stream choices unsupported")
	}
	if len(body.Choices) == 0 && (len(body.Usage) == 0 || bytes.Equal(body.Usage, []byte("null"))) {
		return StreamEvent{}, p.fail("SSE frame lacks choice or usage")
	}
	for _, choice := range body.Choices {
		if choice.Index != 0 {
			return StreamEvent{}, p.fail("unexpected stream choice index")
		}
		if choice.FinishReason == nil {
			continue
		}
		switch *choice.FinishReason {
		case "stop", "tool_calls", "length", "content_filter":
			p.finish = *choice.FinishReason
		default:
			return StreamEvent{}, p.fail("unsupported stream finish reason")
		}
	}
	return StreamEvent{Data: append([]byte(nil), data...)}, nil
}

// Finish must be called on EOF. A disconnected/truncated stream is never success.
func (p *StreamParser) Finish() error {
	if p.failure != nil {
		return p.failure
	}
	if !p.done || len(p.line) > 0 || p.hasData {
		p.failure = io.ErrUnexpectedEOF
		return p.failure
	}
	return nil
}
