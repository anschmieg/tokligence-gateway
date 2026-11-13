package registry

import (
	"github.com/router-for-me/CLIProxyAPI/v8/internal/catalogfallback"
	"strings"
)

func CanonicalFallbackCapabilities(m *ModelInfo) catalogfallback.Capabilities {
	if m == nil {
		return catalogfallback.Capabilities{}
	}
	c := catalogfallback.Capabilities{Context: m.ContextLength, InputLimit: m.InputTokenLimit, Output: m.MaxCompletionTokens, InputModalities: lowerModalities(m.SupportedInputModalities), OutputModalities: lowerModalities(m.SupportedOutputModalities), Chat: true}
	if c.Context <= 0 {
		c.Context = m.InputTokenLimit
	}
	if c.Output <= 0 {
		c.Output = m.OutputTokenLimit
	}
	for _, p := range m.SupportedParameters {
		switch strings.ToLower(p) {
		case "tools":
			c.Tools = true
		case "tool_choice":
			c.ToolChoice = true
		case "parallel_tool_calls":
			c.Parallel = true
		case "response_format":
			c.JSON = true
		case "structured_outputs", "json_schema":
			c.StructuredJSON = true
			c.JSON = true
		case "reasoning", "reasoning_effort":
			c.Reasoning = true
		}
	}
	if m.Thinking != nil {
		c.Reasoning = true
		c.ReasoningLevels = lowerModalities(m.Thinking.Levels)
		c.BudgetMin = m.Thinking.Min
		c.BudgetMax = m.Thinking.Max
		c.AutoReasoning = m.Thinking.DynamicAllowed
		c.DisableReasoning = m.Thinking.ZeroAllowed
	}
	if len(m.SupportedGenerationMethods) > 0 {
		c.Chat = false
		for _, method := range m.SupportedGenerationMethods {
			switch strings.NewReplacer("-", "", "_", "", "/", "", ".", "").Replace(strings.ToLower(method)) {
			case "generatecontent", "streamgeneratecontent", "chat", "chatcompletions", "completions", "textgeneration":
				c.Chat = true
			}
		}
	}
	switch strings.ToLower(m.Type) {
	case "embedding", "reranking", "transcription", "image", "video", "speech", "decision":
		c.Chat = false
	}
	return c
}
func lowerModalities(input []string) []string {
	out := make([]string, 0, len(input))
	for _, s := range input {
		out = append(out, strings.ToLower(s))
	}
	return out
}
