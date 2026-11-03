package handlers

// Inspect protocol history only, not arbitrary tool schemas, metadata, or text
// that happens to mention a signature. Never strip/rewrite conversation state.
func canonicalHistoryRequirements(root map[string]any, r *canonicalRequirements) {
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
	assistantTurns := 0
	var visit func(any, bool)
	visit = func(value any, assistant bool) {
		switch v := value.(type) {
		case []any:
			for _, item := range v {
				visit(item, assistant)
			}
		case map[string]any:
			role, _ := v["role"].(string)
			if role == "assistant" || role == "model" {
				assistant = true
				assistantTurns++
			}
			if role == "tool" || role == "function" {
				r.Tools = true
				r.Continuity = true
			}
			typ, _ := v["type"].(string)
			switch typ {
			case "function_call", "function_call_output", "tool_use", "tool_result":
				r.Tools = true
				r.Continuity = true
			case "thinking", "reasoning", "reasoning.text", "reasoning.summary", "redacted_thinking", "reasoning.encrypted", "reasoning.signature":
				r.Reasoning = true
				r.Continuity = true
				if typ == "redacted_thinking" || typ == "reasoning.encrypted" || typ == "reasoning.signature" {
					r.OpaqueState = true
				}
				// A reasoning item ID can refer to server state even with a summary;
				// summary text does not prove the hidden reasoning is portable.
				if typ == "reasoning" && present(v["id"]) {
					r.OpaqueState = true
				}
			case "item_reference", "web_search_call", "file_search_call", "computer_call", "code_interpreter_call", "mcp_call":
				r.OpaqueState = true
			}
			for _, key := range []string{"thoughtSignature", "thought_signature", "encrypted_content", "reasoning_opaque"} {
				if present(v[key]) {
					r.OpaqueState = true
				}
			}
			if (assistant || typ == "thinking" || typ == "reasoning") && present(v["signature"]) {
				r.OpaqueState = true
			}
			if assistant {
				if calls, ok := v["tool_calls"].([]any); ok && len(calls) > 0 {
					r.Tools = true
					r.Continuity = true
				}
				if present(v["function_call"]) {
					r.Tools = true
					r.Continuity = true
				}
				if present(v["reasoning_content"]) || present(v["reasoning"]) || present(v["reasoning_details"]) {
					r.Reasoning = true
					r.Continuity = true
				}
			}
			if thought, ok := v["thought"].(bool); ok && thought {
				r.Reasoning = true
				r.Continuity = true
			}
			if present(v["functionCall"]) || present(v["functionResponse"]) {
				r.Tools = true
				r.Continuity = true
			}
			// Preserve vendor extras on history items, but do not inspect arguments or
			// tool-result data as if their user-defined keys were protocol fields.
			for _, key := range []string{"content", "parts", "tool_calls", "function_call", "extra_content", "google", "reasoning", "reasoning_details"} {
				if child, ok := v[key]; ok {
					visit(child, assistant)
				}
			}
		}
	}
	for _, key := range []string{"messages", "contents", "input"} {
		visit(root[key], false)
	}
	if assistantTurns >= 2 {
		r.Continuity = true
	}
}
