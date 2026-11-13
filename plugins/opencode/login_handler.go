package opencode

import (
	"context"
	"fmt"
	"strings"
)

// DeviceLoginRequest mirrors the host's native login RPCs, including the
// callback context which authorizes HTTP only for this individual call.
type DeviceLoginRequest struct {
	Provider       string `json:"Provider"`
	State          string `json:"State"`
	HostCallbackID string `json:"host_callback_id"`
}

func (h *Handler) handleDeviceLogin(request []byte, poll bool) ([]byte, error) {
	var req DeviceLoginRequest
	if err := decodeInto(request, &req); err != nil {
		return nil, err
	}
	if req.Provider != ProviderKey {
		return nil, withStatus(400, fmt.Errorf("opencode login requires its own provider"))
	}
	if strings.TrimSpace(req.HostCallbackID) == "" {
		return nil, withStatus(400, fmt.Errorf("opencode login requires a host callback context"))
	}
	if h.deviceLogin == nil || h.transport == nil {
		return nil, withStatus(503, fmt.Errorf("opencode login transport is unavailable"))
	}
	ctx := WithHostCallbackID(context.Background(), req.HostCallbackID)
	if poll {
		resp, err := h.deviceLogin.Poll(ctx, req.State)
		if err != nil {
			return nil, err
		}
		return okEnvelope(resp)
	}
	resp, err := h.deviceLogin.Start(ctx)
	if err != nil {
		return nil, err
	}
	return okEnvelope(resp)
}
