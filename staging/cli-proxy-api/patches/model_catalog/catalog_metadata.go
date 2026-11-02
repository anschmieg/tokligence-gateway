package registry

import (
	"reflect"
	"sort"
	"strings"
)

// commonModelInfo is called under the registry lock. A shared ID promises only
// the contract common to its registered providers, independent of load order.
func commonModelInfo(reg *ModelRegistration) *ModelInfo {
	if reg == nil {
		return nil
	}
	result := cloneModelInfo(reg.Info)
	if result == nil {
		return nil
	}
	var infos []*ModelInfo
	for provider, info := range reg.InfoByProvider {
		if info != nil && reg.Providers[provider] > 0 {
			infos = append(infos, info)
		}
	}
	if len(infos) < 2 {
		return result
	}
	result = cloneModelInfo(infos[0])
	owners := map[string]bool{}
	for _, info := range infos {
		owners[info.OwnedBy] = true
	}
	for _, info := range infos[1:] {
		result.ContextLength = commonLimit(result.ContextLength, info.ContextLength)
		result.MaxContextLength = commonLimit(result.MaxContextLength, info.MaxContextLength)
		result.InputTokenLimit = commonLimit(result.InputTokenLimit, info.InputTokenLimit)
		result.OutputTokenLimit = commonLimit(result.OutputTokenLimit, info.OutputTokenLimit)
		result.MaxCompletionTokens = commonLimit(result.MaxCompletionTokens, info.MaxCompletionTokens)
		result.SupportedParameters = commonStrings(result.SupportedParameters, info.SupportedParameters)
		result.SupportedInputModalities = commonStrings(result.SupportedInputModalities, info.SupportedInputModalities)
		result.SupportedOutputModalities = commonStrings(result.SupportedOutputModalities, info.SupportedOutputModalities)
		result.SupportedGenerationMethods = commonStrings(result.SupportedGenerationMethods, info.SupportedGenerationMethods)
		if !reflect.DeepEqual(result.Thinking, info.Thinking) {
			result.Thinking = nil
		}
		result.SupportsWebSearch = result.SupportsWebSearch && info.SupportsWebSearch
		result.NativeCapabilities = nil
	}
	names := []string{}
	for name := range owners {
		if name != "" {
			names = append(names, name)
		}
	}
	sort.Strings(names)
	result.OwnedBy = strings.Join(names, ",")
	return result
}
func commonLimit(a, b int) int {
	if a <= 0 || b <= 0 {
		return 0
	}
	if b < a {
		return b
	}
	return a
}
func commonStrings(a, b []string) []string {
	result := []string{}
	for _, v := range a {
		for _, w := range b {
			if v == w {
				result = append(result, v)
				break
			}
		}
	}
	return result
}

// CatalogMetadata is additive discovery only; no credentials, config or internal
// runtime overrides are serialized. Nil capabilities mean unknown, not false.
func CatalogMetadata(id string) map[string]any {
	info := GetGlobalRegistry().GetModelInfo(id, "")
	if info == nil {
		return nil
	}
	out := map[string]any{"providers": GetGlobalRegistry().GetModelProviders(id)}
	caps := map[string]any{"tools": nil, "reasoning": nil, "parallel_tool_calls": nil}
	out["capabilities"] = caps
	if len(info.SupportedParameters) > 0 {
		out["supported_parameters"] = append([]string{}, info.SupportedParameters...)
		tools := false
		for _, v := range info.SupportedParameters {
			if v == "reasoning" || v == "reasoning_effort" {
				caps["reasoning"] = true
			}
			if v == "tools" {
				tools = true
			}
		}
		caps["tools"] = tools
	}
	if info.Thinking != nil && (!info.UserDefined || info.ExplicitThinking) {
		out["thinking"] = info.Thinking
		caps["reasoning"] = true
	}
	if info.ContextLength > 0 {
		out["context_length"] = info.ContextLength
	}
	if info.MaxCompletionTokens > 0 {
		out["max_completion_tokens"] = info.MaxCompletionTokens
	}
	if len(info.SupportedInputModalities) > 0 {
		out["input_modalities"] = info.SupportedInputModalities
	}
	if len(info.SupportedOutputModalities) > 0 {
		out["output_modalities"] = info.SupportedOutputModalities
	}
	return out
}
