package opencode

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"sort"
	"strings"
	"unicode/utf8"
)

const responseFrameLimit = 1 << 20
const responseTotalLimit = 8 << 20
const responseHeldLimit = 4 << 20

type responseEvent struct {
	data []byte
	hold bool
}

type responseTool struct {
	ID, Type        string
	Name, Arguments strings.Builder
}

// One decoder per physical response. Line and event buffers are separate:
// neither multiple events per read nor multiline data can overwrite a frame.
type responseDecoder struct {
	line, data    []byte
	hasData, done bool
	total         int
	finish        string
	failure       error
	headers       map[string][]string
	metadata      map[string]json.RawMessage
	text          map[string]*strings.Builder
	tools         map[int]*responseTool
	usage         json.RawMessage
}

func newResponseDecoder(headers map[string][]string) *responseDecoder {
	return &responseDecoder{headers: headers, metadata: map[string]json.RawMessage{}, text: map[string]*strings.Builder{}, tools: map[int]*responseTool{}}
}

func (p *responseDecoder) fail(message string) error {
	p.failure = withStatus(502, fmt.Errorf("opencode response: %s", message))
	return p.failure
}

func (p *responseDecoder) feed(chunk []byte) ([]responseEvent, error) {
	if p.failure != nil {
		return nil, p.failure
	}
	p.total += len(chunk)
	if p.total > responseTotalLimit {
		return nil, p.fail("total exceeds limit")
	}
	var events []responseEvent
	for _, b := range chunk {
		if p.done {
			if b != ' ' && b != '\t' && b != '\r' && b != '\n' {
				return nil, p.fail("data after DONE")
			}
			continue
		}
		if b != '\n' {
			p.line = append(p.line, b)
			if len(p.line)+len(p.data) > responseFrameLimit {
				return nil, p.fail("frame exceeds limit")
			}
			continue
		}
		line := bytes.TrimSuffix(p.line, []byte{'\r'})
		p.line = nil
		if len(line) == 0 {
			if !p.hasData {
				continue
			}
			event, err := p.decode(p.data)
			p.data = nil
			p.hasData = false
			if err != nil {
				return nil, err
			}
			if event.data != nil {
				events = append(events, event)
			}
			continue
		}
		if line[0] == ':' {
			continue
		}
		field, value, _ := bytes.Cut(line, []byte{':'})
		if string(field) != "data" {
			continue
		}
		value = bytes.TrimPrefix(value, []byte{' '})
		if p.hasData {
			p.data = append(p.data, '\n')
		}
		p.data = append(p.data, value...)
		p.hasData = true
		if len(p.data) > responseFrameLimit {
			return nil, p.fail("frame exceeds limit")
		}
	}
	return events, nil
}

func nullJSON(raw json.RawMessage) bool {
	return len(raw) == 0 || bytes.Equal(bytes.TrimSpace(raw), []byte("null"))
}

func embeddedResponseError(raw []byte, headers map[string][]string) error {
	var body map[string]json.RawMessage
	_ = json.Unmarshal(raw, &body)
	var detail map[string]json.RawMessage
	_ = json.Unmarshal(body["error"], &detail)
	status := 502
	for _, key := range []string{"status", "status_code", "statusCode", "code"} {
		var n int
		if json.Unmarshal(detail[key], &n) == nil && n >= 400 && n <= 599 {
			status = n
			break
		}
	}
	for _, key := range []string{"type", "name", "code"} {
		var name string
		if json.Unmarshal(detail[key], &name) == nil && name == "FreeUsageLimitError" {
			status = 429
		}
	}
	return ClassifyRejection(status, headers, raw).statusError()
}

func (p *responseDecoder) decode(raw []byte) (responseEvent, error) {
	if bytes.Equal(raw, []byte("[DONE]")) {
		if p.finish == "" {
			return responseEvent{}, p.fail("DONE lacks finish reason")
		}
		p.done = true
		return responseEvent{}, nil
	}
	var body map[string]json.RawMessage
	if !utf8.Valid(raw) || json.Unmarshal(raw, &body) != nil || body == nil {
		return responseEvent{}, p.fail("invalid JSON object")
	}
	if !nullJSON(body["error"]) {
		p.failure = embeddedResponseError(raw, p.headers)
		return responseEvent{}, p.failure
	}
	for key, value := range body {
		switch key {
		case "choices", "usage", "error", "object":
			continue
		}
		if key == "id" || key == "model" {
			if nullJSON(value) {
				continue
			}
			var text *string
			if json.Unmarshal(value, &text) != nil || text == nil {
				return responseEvent{}, p.fail("invalid response identity")
			}
		}
		if key == "created" {
			if nullJSON(value) {
				continue
			}
			var created *int64
			if json.Unmarshal(value, &created) != nil || created == nil {
				return responseEvent{}, p.fail("invalid response timestamp")
			}
		}
		if old, ok := p.metadata[key]; ok && (key == "id" || key == "model" || key == "created") && !bytes.Equal(old, value) {
			return responseEvent{}, p.fail("response identity changed")
		}
		p.metadata[key] = append(json.RawMessage(nil), value...)
	}
	var choices []map[string]json.RawMessage
	if !nullJSON(body["choices"]) && json.Unmarshal(body["choices"], &choices) != nil {
		return responseEvent{}, p.fail("invalid choices")
	}
	if len(choices) > 1 {
		return responseEvent{}, p.fail("multiple choices unsupported")
	}
	hold := !nullJSON(body["usage"])
	if hold {
		var usage map[string]json.RawMessage
		if json.Unmarshal(body["usage"], &usage) != nil || usage == nil {
			return responseEvent{}, p.fail("invalid usage object")
		}
		p.usage = append(json.RawMessage(nil), body["usage"]...)
	}
	if len(choices) == 0 && !hold {
		return responseEvent{}, p.fail("frame lacks choice or usage")
	}
	normalizedFinish := false
	for _, choice := range choices {
		if p.finish != "" {
			return responseEvent{}, p.fail("choice after finish reason")
		}
		var index *int
		if json.Unmarshal(choice["index"], &index) != nil || index == nil || *index != 0 {
			return responseEvent{}, p.fail("choice index must be zero")
		}
		// Native OpenAIChatChoice uses StructWithRest: extension fields are
		// tolerated, while the choice/delta/tool structures remain validated.
		var delta map[string]json.RawMessage
		if !nullJSON(choice["delta"]) && json.Unmarshal(choice["delta"], &delta) != nil {
			return responseEvent{}, p.fail("invalid delta")
		}
		for key, value := range delta {
			switch key {
			case "role":
				var role string
				if json.Unmarshal(value, &role) != nil || role != "assistant" {
					return responseEvent{}, p.fail("delta role must be assistant")
				}
			case "content", "refusal", "reasoning_content", "reasoning", "reasoning_text":
				if nullJSON(value) {
					continue
				}
				var text string
				if json.Unmarshal(value, &text) != nil {
					return responseEvent{}, p.fail("non-text delta unsupported")
				}
				if p.text[key] == nil {
					p.text[key] = &strings.Builder{}
				}
				p.text[key].WriteString(text)
			case "tool_calls":
				if nullJSON(value) {
					continue
				}
				var calls []map[string]json.RawMessage
				if json.Unmarshal(value, &calls) != nil {
					return responseEvent{}, p.fail("invalid tool calls")
				}
				if len(calls) > 0 {
					hold = true
				}
				for _, call := range calls {
					if err := p.addTool(call); err != nil {
						return responseEvent{}, err
					}
				}
			default:
				// Native OpenAIChatDelta permits unknown provider extensions.
				// Legacy executable function deltas need an explicit translator;
				// never forward those as unvalidated tools.
				if key == "function_call" && !nullJSON(value) {
					return responseEvent{}, p.fail("legacy function delta unsupported")
				}
			}
		}
		if !nullJSON(choice["finish_reason"]) {
			if json.Unmarshal(choice["finish_reason"], &p.finish) != nil {
				return responseEvent{}, p.fail("invalid finish reason")
			}
			switch p.finish {
			case "end":
				p.finish = "stop"
				normalizedFinish = true
			case "function_call":
				p.finish = "tool_calls"
				normalizedFinish = true
			}
			if normalizedFinish {
				choice["finish_reason"], _ = json.Marshal(p.finish)
			}
			switch p.finish {
			case "stop", "tool_calls", "length", "content_filter":
			default:
				return responseEvent{}, p.fail("unsupported finish reason")
			}
			hold = true
		}
	}
	if normalizedFinish {
		body["choices"], _ = json.Marshal(choices)
		raw, _ = json.Marshal(body)
	}
	return responseEvent{data: append([]byte(nil), raw...), hold: hold}, nil
}

func (p *responseDecoder) addTool(call map[string]json.RawMessage) error {
	var index *int
	if json.Unmarshal(call["index"], &index) != nil || index == nil || *index < 0 || *index > 127 {
		return p.fail("invalid tool index")
	}
	tool := p.tools[*index]
	if tool == nil {
		tool = &responseTool{}
		p.tools[*index] = tool
	}
	for key, value := range call {
		switch key {
		case "index":
		case "id", "type":
			var text string
			if json.Unmarshal(value, &text) != nil {
				return p.fail("invalid tool identity")
			}
			field := &tool.ID
			if key == "type" {
				field = &tool.Type
			}
			if *field != "" && *field != text {
				return p.fail("tool identity changed")
			}
			*field = text
		case "function":
			var fn map[string]json.RawMessage
			if json.Unmarshal(value, &fn) != nil || fn == nil {
				return p.fail("invalid tool function")
			}
			for name, raw := range fn {
				var text string
				if json.Unmarshal(raw, &text) != nil {
					return p.fail("invalid tool function text")
				}
				switch name {
				case "name":
					tool.Name.WriteString(text)
				case "arguments":
					tool.Arguments.WriteString(text)
				default:
					return p.fail("unsupported function field")
				}
			}
		default:
			return p.fail("unsupported tool field")
		}
	}
	return nil
}

func (p *responseDecoder) finishResponse() ([]byte, error) {
	if p.failure != nil {
		return nil, p.failure
	}
	if !p.done || p.hasData || len(p.line) > 0 {
		return nil, p.fail(io.ErrUnexpectedEOF.Error())
	}
	if p.finish != "stop" && p.finish != "tool_calls" {
		return nil, p.fail("finish_reason=" + p.finish)
	}
	if p.finish == "tool_calls" && len(p.tools) == 0 {
		return nil, p.fail("tool_calls finish without tools")
	}
	message := map[string]any{"role": "assistant", "content": nil}
	for key, value := range p.text {
		message[key] = value.String()
	}
	indices := make([]int, 0, len(p.tools))
	for index := range p.tools {
		indices = append(indices, index)
	}
	sort.Ints(indices)
	calls := make([]any, 0, len(indices))
	ids := map[string]bool{}
	for _, index := range indices {
		tool := p.tools[index]
		var args map[string]json.RawMessage
		if tool.ID == "" || ids[tool.ID] || tool.Type != "function" || strings.TrimSpace(tool.Name.String()) == "" || json.Unmarshal([]byte(tool.Arguments.String()), &args) != nil || args == nil {
			return nil, p.fail("incomplete or invalid tool call")
		}
		ids[tool.ID] = true
		calls = append(calls, map[string]any{"id": tool.ID, "type": tool.Type, "function": map[string]string{"name": tool.Name.String(), "arguments": tool.Arguments.String()}})
	}
	if len(calls) > 0 {
		message["tool_calls"] = calls
	}
	out := map[string]any{"object": "chat.completion", "choices": []any{map[string]any{"index": 0, "message": message, "finish_reason": p.finish}}}
	for key, value := range p.metadata {
		out[key] = value
	}
	if p.usage != nil {
		out["usage"] = p.usage
	}
	return json.Marshal(out)
}

// Relay emits complete SSE frames. Executable calls and terminal frames commit
// only after DONE *and* transport EOF; a late read error defeats the commit.
func RelayOpenCodeSSE(chunks <-chan StreamChunk, headers map[string][]string, emit func([]byte) error) error {
	if chunks == nil || emit == nil {
		return withStatus(502, fmt.Errorf("opencode stream dependencies unavailable"))
	}
	p := newResponseDecoder(headers)
	var held [][]byte
	heldBytes := 0
	holding := false
	for chunk := range chunks {
		if chunk.Err != nil {
			return withStatus(502, fmt.Errorf("opencode upstream stream failed"))
		}
		events, err := p.feed(chunk.Payload)
		if err != nil {
			return err
		}
		for _, event := range events {
			// Compact to one SSE data line, including multiline upstream JSON.
			var compact bytes.Buffer
			if err := json.Compact(&compact, event.data); err != nil {
				return err
			}
			frame := append([]byte("data: "), compact.Bytes()...)
			frame = append(frame, '\n', '\n')
			holding = holding || event.hold
			if holding {
				heldBytes += len(frame)
				if heldBytes > responseHeldLimit {
					return p.fail("withheld frames exceed limit")
				}
				held = append(held, frame)
			} else if err := emit(frame); err != nil {
				return err
			}
		}
	}
	if _, err := p.finishResponse(); err != nil {
		return err
	}
	for _, frame := range held {
		if err := emit(frame); err != nil {
			return err
		}
	}
	return nil
}

func CollectOpenCodeSSE(body []byte, headers map[string][]string) ([]byte, error) {
	p := newResponseDecoder(headers)
	if _, err := p.feed(body); err != nil {
		return nil, err
	}
	return p.finishResponse()
}
