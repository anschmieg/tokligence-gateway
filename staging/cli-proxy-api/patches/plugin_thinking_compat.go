package pluginhost

import (
	"context"
	"fmt"

	"github.com/router-for-me/CLIProxyAPI/v8/internal/runtime/executor/helps"
	sdktranslator "github.com/router-for-me/CLIProxyAPI/v8/sdk/translator"
)

// Explicit per-plugin endpoint policy. OAuth plugin models do not inherit
// API-key model IsCompat. Select the EXISTING compatibility translator instead
// of inventing signatures, restoring text by index, or rebuilding a codec.
func (a *executorAdapter) translateConfiguredPluginRequest(ctx context.Context, from, to sdktranslator.Format, request sdktranslator.RequestEnvelope) sdktranslator.RequestEnvelope {
	if a == nil || a.host == nil || from != sdktranslator.FormatClaude || to != sdktranslator.FormatOpenAI {
		return sdktranslator.TranslateRequestEnvelope(ctx, from, to, request)
	}
	cfg := a.host.currentRuntimeConfig()
	if cfg == nil {
		return sdktranslator.TranslateRequestEnvelope(ctx, from, to, request)
	}
	item, exists := cfg.Plugins.Configs[a.pluginID]
	if !exists {
		return sdktranslator.TranslateRequestEnvelope(ctx, from, to, request)
	}
	var policy struct {
		Preserve bool `yaml:"preserve_unsigned_thinking"`
	}
	if err := item.Raw.Decode(&policy); err != nil {
		request.Err = fmt.Errorf("plugin thinking compatibility policy is invalid")
		return request
	}
	if !policy.Preserve {
		return sdktranslator.TranslateRequestEnvelope(ctx, from, to, request)
	}
	request.Body, request.Err = helps.TranslateRequestReturningError(ctx, nil, cfg, from, to, request.Model, request.Body, request.Stream, true)
	request.Format = to
	return request
}
