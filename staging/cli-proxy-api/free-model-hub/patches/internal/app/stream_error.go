package app

import (
	"errors"
	"net/http"

	"free-model-hub/cpasdk/pluginabi"
	"free-model-hub/internal/core"
	"free-model-hub/internal/hostbridge"
)

// Native schema10 accepts error_detail on stream close. Plain text loses the
// upstream status and makes quota/auth failures generic500 at the host.
func closeStreamFailure(callbackID, streamID string, failure error) {
	if streamID == "" {
		return
	}
	var detail *core.PluginError
	if !errors.As(failure, &detail) {
		mapped := core.ToPluginError(failure)
		if !errors.As(mapped, &detail) {
			detail = core.NewPluginError("upstream_request_failed", "upstream request failed", http.StatusBadGateway)
		}
	}
	status := detail.HTTPStatus
	if status < 400 || status > 599 {
		status = http.StatusBadGateway
	}
	_, _ = hostbridge.Call(callbackID, pluginabi.MethodHostStreamClose, map[string]any{
		"stream_id":    streamID,
		"error_detail": map[string]any{"code": detail.Code, "message": streamFailureMessage(failure), "http_status": status},
	})
}
