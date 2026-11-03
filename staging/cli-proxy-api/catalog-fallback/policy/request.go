package catalogfallback

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"math"
	"strconv"
	"strings"
)

// RequirementsFromJSON reads protocol fields only. It never interprets tool
// schemas, arguments, result payloads or arbitrary user text as protocol state.
func RequirementsFromJSON(raw []byte) (Requirements, error) {
	if err := validateJSONKeys(raw); err != nil {
		return Requirements{}, err
	}
	r := Requirements{Bytes: len(raw), Modalities: map[string]bool{"text": true}, Outputs: map[string]bool{"text": true}}
	var root map[string]any
	d := json.NewDecoder(bytes.NewReader(raw))
	d.UseNumber()
	if err := d.Decode(&root); err != nil || root == nil {
		return r, errors.New("expected JSON request object")
	}
	r.UnverifiedCostFeatures = !noChargeRequestFeatures(root)
	if d.Decode(new(any)) != io.EOF {
		return r, errors.New("trailing JSON request value")
	}
	var parseErr error
	number := func(v any) int {
		n, ok := v.(json.Number)
		if !ok {
			parseErr = errors.New("invalid token budget")
			return 0
		}
		value, err := strconv.ParseInt(string(n), 10, 64)
		if err != nil || value < 0 || value > math.MaxInt32 {
			parseErr = errors.New("invalid token budget")
			return 0
		}
		return int(value)
	}
	for _, k := range []string{"max_tokens", "max_completion_tokens", "max_output_tokens"} {
		if v, ok := root[k]; ok {
			n := number(v)
			if n > r.Output {
				r.Output = n
			}
		}
	}
	present := func(v any) bool {
		if v == nil {
			return false
		}
		if s, ok := v.(string); ok {
			return s != ""
		}
		return true
	}
	if present(root["previous_response_id"]) || present(root["conversation"]) {
		r.OpaqueState = true
	}
	for _, k := range []string{"tools", "functions"} {
		if tools, ok := root[k].([]any); ok && len(tools) > 0 {
			r.Tools = true
			for _, item := range tools {
				if m, ok := item.(map[string]any); ok {
					typ, _ := m["type"].(string)
					if typ != "" && typ != "function" {
						r.OpaqueState = true
					}
				}
			}
		}
	}
	if v, ok := root["parallel_tool_calls"].(bool); ok {
		r.Parallel = v
	}
	if choice, ok := root["tool_choice"]; ok && choice != "none" {
		r.Tools = true
		r.ToolChoice = true
	}
	if choice, ok := root["function_call"]; ok && choice != "none" {
		r.Tools = true
		r.ToolChoice = true
	}
	setEffort := func(v any) {
		s, ok := v.(string)
		if !ok {
			parseErr = errors.New("invalid reasoning effort")
			return
		}
		if s == "none" {
			r.DisableReasoning = true
		} else {
			r.Reasoning = true
			r.ReasoningEffort = s
		}
	}
	budget := func(v any) {
		if n, ok := v.(json.Number); ok && string(n) == "-1" {
			value := -1
			r.ReasoningBudget = &value
			r.Reasoning = true
			return
		}
		n := number(v)
		r.ReasoningBudget = &n
		if n == 0 {
			r.DisableReasoning = true
		} else {
			r.Reasoning = true
		}
	}
	if v, ok := root["reasoning_effort"]; ok {
		setEffort(v)
	}
	if thinking, ok := root["thinking"].(map[string]any); ok {
		if thinking["type"] == "disabled" {
			r.DisableReasoning = true
		} else {
			r.Reasoning = true
		}
		if v, ok := thinking["budget_tokens"]; ok {
			budget(v)
		}
	}
	if reasoning, ok := root["reasoning"].(map[string]any); ok {
		r.Reasoning = true
		if v, ok := reasoning["effort"]; ok {
			setEffort(v)
		}
	}
	format := func(v any) {
		if m, ok := v.(map[string]any); ok {
			if m["type"] == "json_schema" {
				r.JSON = true
				r.StructuredJSON = true
			} else if m["type"] == "json_object" {
				r.JSON = true
			}
		}
	}
	format(root["response_format"])
	if text, ok := root["text"].(map[string]any); ok {
		format(text["format"])
	}
	if output, ok := root["output_config"].(map[string]any); ok {
		format(output["format"])
		if v, ok := output["effort"]; ok {
			setEffort(v)
		}
	}
	if modes, ok := root["modalities"].([]any); ok {
		for _, m := range modes {
			if s, ok := m.(string); ok {
				r.Outputs[s] = true
			}
		}
	}
	if gen, ok := root["generationConfig"].(map[string]any); ok {
		if v, ok := gen["maxOutputTokens"]; ok {
			n := number(v)
			if n > r.Output {
				r.Output = n
			}
		}
		if mime, ok := gen["responseMimeType"].(string); ok && mime != "text/plain" {
			r.JSON = true
		}
		if present(gen["responseSchema"]) || present(gen["responseJsonSchema"]) {
			r.JSON = true
			r.StructuredJSON = true
		}
		if modes, ok := gen["responseModalities"].([]any); ok {
			for _, m := range modes {
				if s, ok := m.(string); ok {
					r.Outputs[strings.ToLower(s)] = true
				}
			}
		}
		if thinking, ok := gen["thinkingConfig"].(map[string]any); ok {
			r.Reasoning = true
			if v, ok := thinking["thinkingBudget"]; ok {
				budget(v)
			}
			if v, ok := thinking["thinkingLevel"]; ok {
				setEffort(v)
			}
		}
	}
	// Native Gemini controls are requirements too; do not infer them from the
	// mere presence of declarations or rely on a downstream translator to reject.
	if config, ok := root["toolConfig"].(map[string]any); ok {
		if calls, ok := config["functionCallingConfig"].(map[string]any); ok {
			mode, _ := calls["mode"].(string)
			switch strings.ToUpper(mode) {
			case "ANY":
				r.Tools = true
				r.ToolChoice = true
			case "", "AUTO", "NONE", "VALIDATED":
			default:
				parseErr = errors.New("unknown function calling mode")
			}
			if names, ok := calls["allowedFunctionNames"].([]any); ok && len(names) > 0 && strings.ToUpper(mode) != "NONE" {
				r.Tools = true
				r.ToolChoice = true
			}
		}
	}
	turns := 0
	var extras func(map[string]any)
	extras = func(m map[string]any) {
		for _, key := range []string{"thoughtSignature", "thought_signature", "encrypted_content", "reasoning_opaque", "signature"} {
			if present(m[key]) {
				r.OpaqueState = true
			}
		}
		for _, key := range []string{"extra_content", "google", "function"} {
			if child, ok := m[key].(map[string]any); ok {
				extras(child)
			}
		}
	}
	var content func(any, bool, bool)
	content = func(v any, assistant, gemini bool) {
		switch x := v.(type) {
		case []any:
			for _, item := range x {
				content(item, assistant, gemini)
			}
		case map[string]any:
			typ, _ := x["type"].(string)
			switch typ {
			case "thinking", "reasoning", "reasoning.text", "reasoning.summary":
				r.Reasoning = true
				r.Continuity = true
				extras(x)
				if typ == "reasoning" && present(x["id"]) {
					r.OpaqueState = true
				}
			case "redacted_thinking", "reasoning.encrypted", "reasoning.signature", "item_reference", "web_search_call", "file_search_call", "computer_call", "code_interpreter_call", "mcp_call":
				r.OpaqueState = true
			case "function_call", "function_call_output", "tool_use", "tool_result":
				r.Tools = true
				r.Continuity = true
				extras(x)
			case "image", "image_url", "input_image":
				r.Modalities["image"] = true
			case "input_audio", "audio":
				r.Modalities["audio"] = true
			case "video", "video_url", "input_video":
				r.Modalities["video"] = true
			case "input_file", "file", "document":
				r.Modalities["file"] = true
			}
			if assistant {
				extras(x)
			}
			if gemini {
				extras(x)
				if present(x["fileData"]) || present(x["inlineData"]) || present(x["file_data"]) || present(x["inline_data"]) {
					r.Modalities["file"] = true
				}
				if present(x["functionCall"]) || present(x["functionResponse"]) {
					r.Tools = true
					r.Continuity = true
				}
				if x["thought"] == true {
					r.Reasoning = true
					r.Continuity = true
				}
			}
			// A tool result's content may be arbitrary JSON; only actual protocol
			// content blocks from that list are traversed, never result/arguments maps.
			if blocks, ok := x["content"].([]any); ok {
				content(blocks, assistant, gemini)
			}
		}
	}
	visit := func(v any, gemini bool) {
		items, _ := v.([]any)
		for _, item := range items {
			m, ok := item.(map[string]any)
			if !ok {
				continue
			}
			role, _ := m["role"].(string)
			assistant := role == "assistant" || role == "model"
			if assistant {
				turns++
				extras(m)
			}
			if role == "tool" || role == "function" {
				r.Tools = true
				r.Continuity = true
			}
			if assistant {
				if present(m["reasoning_content"]) || present(m["reasoning_details"]) {
					r.Reasoning = true
					r.Continuity = true
				}
				if calls, ok := m["tool_calls"].([]any); ok && len(calls) > 0 {
					r.Tools = true
					r.Continuity = true
					for _, call := range calls {
						if c, ok := call.(map[string]any); ok {
							extras(c)
						}
					}
				}
				if call, ok := m["function_call"].(map[string]any); ok {
					r.Tools = true
					r.Continuity = true
					extras(call)
				}
				content(m["reasoning_details"], true, false)
			}
			content(m, assistant, gemini)
			content(m["content"], assistant, gemini)
			if gemini {
				content(m["parts"], assistant, true)
			}
		}
	}
	visit(root["messages"], false)
	visit(root["input"], false)
	visit(root["contents"], true)
	if turns >= 2 {
		r.Continuity = true
	}
	switch {
	case r.Tools:
		r.Task = Agent
	case r.StructuredJSON || r.JSON:
		r.Task = Structured
	case r.Reasoning:
		r.Task = Reasoning
	default:
		r.Task = General
	}
	return r, parseErr
}

// Unverified request-side spending options are separate from base-model price.
// Caller-executed function declarations are inert proposals; hosted tools,
// upstream fallback graphs and premium serving tiers need their own cost proof.
func noChargeRequestFeatures(root map[string]any) bool {
	for _, key := range []string{"models", "provider", "routing", "route", "web_search", "web_search_options"} {
		if v, ok := root[key]; ok && v != nil {
			return false
		}
	}
	if tier, ok := root["service_tier"]; ok && tier != "" && tier != "default" {
		return false
	}
	if tools, ok := root["tools"].([]any); ok {
		for _, v := range tools {
			tool, ok := v.(map[string]any)
			if !ok {
				return false
			}
			if typ, _ := tool["type"].(string); typ != "" && typ != "function" {
				return false
			}
			for _, key := range []string{"googleSearch", "google_search", "googleSearchRetrieval", "urlContext", "codeExecution", "retrieval"} {
				if _, ok := tool[key]; ok {
					return false
				}
			}
		}
	}
	return true
}
