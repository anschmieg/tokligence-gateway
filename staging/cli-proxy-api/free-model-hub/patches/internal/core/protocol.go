package core

import (
	"strings"

	"free-model-hub/cpasdk/pluginapi"
)

// ToolParameters returns the parameters that must be listed when declaring "supports tool calling".
//
// Registration conversion and admin merge/backfill paths share this definition to prevent literals from scattering.
// The contradiction where "a method declares tool_calls, but parameters lacks tools".
//
// Returns a new slice instead of a package-level variable: package-level mutable state can be modified by any caller, whereas this list
// is the declaration source shared by all providers. The call frequency is "each catalog refresh × each model",
// and the allocation of two elements is negligible.
func ToolParameters() []string {
	return []string{"tools", "tool_choice"}
}

// ModelInfoToPluginAPI converts a neutral model description into a host contract type.
//
// vendorID populates OwnedBy; the model ID remains bare (see the documentation of SplitModelID).
func ModelInfoToPluginAPI(vendorID string, info ModelDescriptor) pluginapi.ModelInfo {
	id := strings.TrimSpace(info.ID)
	name := strings.TrimSpace(info.Name)
	if name == "" {
		name = id
	}
	out := pluginapi.ModelInfo{
		ID:                       id,
		Object:                   "model",
		OwnedBy:                  vendorID,
		Type:                     "chat",
		DisplayName:              name,
		Name:                     id,
		Description:              info.Description,
		ContextLength:            info.ContextLength,
		InputTokenLimit:          info.ContextLength,
		MaxCompletionTokens:      info.MaxOutputTokens,
		OutputTokenLimit:         info.MaxOutputTokens,
		SupportedInputModalities: []string{"text"},
		// Parameter capabilities must follow the model declaration: unconditionally listing them would cause clients to render
		// tool switches for models that do not support tool calling, resulting in upstream 400 errors when sent. Basic sampling parameters are
		// accepted by all chat models and are always retained.
		SupportedParameters: []string{"temperature", "top_p", "max_tokens", "stream"},
	}
	if len(info.InputModalities) > 0 {
		out.SupportedInputModalities = append([]string(nil), info.InputModalities...)
	}
	out.SupportedOutputModalities = append([]string(nil), info.OutputModalities...)
	if info.VendorID != "" {
		out.OwnedBy = info.VendorID
		out.Type = "model"
	}
	out.SupportedGenerationMethods = []string{"generateContent"}
	if info.ParametersKnown {
		out.SupportedParameters = append([]string(nil), info.Parameters...)
	}
	if info.SupportsImages && !containsModality(out.SupportedInputModalities, "image") {
		out.SupportedInputModalities = append(out.SupportedInputModalities, "image")
	}
	if info.SupportsTools {
		// Tools are request parameters, not a Gemini generation operation.
		if !info.ParametersKnown {
			out.SupportedParameters = append(out.SupportedParameters, ToolParameters()...)
		}
	}
	if len(info.Efforts) > 0 || info.DefaultEffort != "" {
		out.Thinking = &pluginapi.ThinkingSupport{
			Levels:         info.Efforts,
			DynamicAllowed: info.DefaultEffort != "",
			ZeroAllowed:    info.CanDisableThinking,
		}
	}
	return out
}

// ModelDescriptor is the model metadata provided by the vendor (a vendor-agnostic neutral form).
//
// Upstream model structures vary greatly across vendors; only the fields actually used when registering with the host are kept here,
// and each vendor performs the conversion within its own package.
type ModelDescriptor struct {
	VendorID         string
	Parameters       []string
	ParametersKnown  bool
	InputModalities  []string
	OutputModalities []string
	ID               string
	Name             string
	Description      string
	ContextLength    int64
	MaxOutputTokens  int64
	Efforts          []string
	DefaultEffort    string
	SupportsImages   bool
	SupportsTools    bool
	// CanDisableThinking reports whether the model allows disabling thinking.
	CanDisableThinking bool
}

// ModelSupportsImages reports whether the model declares image input capability.
func ModelSupportsImages(model pluginapi.ModelInfo) bool {
	for _, modality := range model.SupportedInputModalities {
		if strings.EqualFold(strings.TrimSpace(modality), "image") {
			return true
		}
	}
	return false
}

// ModelSupportsTools reports whether the model declares tool calling capability.
func ModelSupportsTools(model pluginapi.ModelInfo) bool {
	for _, parameter := range model.SupportedParameters {
		if parameter == "tools" {
			return true
		}
	}
	return false
}

func containsModality(values []string, value string) bool {
	for _, item := range values {
		if strings.EqualFold(item, value) {
			return true
		}
	}
	return false
}
