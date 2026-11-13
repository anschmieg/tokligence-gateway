package app

import (
	"encoding/json"
	"errors"
	"fmt"
	"testing"

	"free-model-hub/internal/core"
	"free-model-hub/internal/hostbridge"
)

func TestFreeHubStreamStatusPreserved(t *testing.T) {
	for _, status := range []int{401, 403, 404, 429, 503} {
		t.Run(fmt.Sprint(status), func(t *testing.T) {
			calls := 0
			hostbridge.Configure(func(callbackID, method string, payload any) (json.RawMessage, error) {
				calls++
				raw, _ := json.Marshal(payload)
				var req struct {
					StreamID string `json:"stream_id"`
					Detail   struct {
						Status int    `json:"http_status"`
						Code   string `json:"code"`
					} `json:"error_detail"`
				}
				if err := json.Unmarshal(raw, &req); err != nil {
					t.Fatal(err)
				}
				if callbackID != "callback" || method != "host.stream.close" || req.StreamID != "stream" || req.Detail.Status != status || req.Detail.Code != "upstream_fixture" {
					t.Fatalf("structured close mismatch: %s", raw)
				}
				return json.RawMessage(`{}`), nil
			})
			defer hostbridge.Configure(nil)
			closeStreamFailure("callback", "stream", fmt.Errorf("wrapped: %w", core.NewPluginError("upstream_fixture", "fixture error", status)))
			if calls != 1 {
				t.Fatal("close count differs")
			}
		})
	}
}
func TestFreeHubStreamUnknownErrorIs502(t *testing.T) {
	hostbridge.Configure(func(_, _ string, payload any) (json.RawMessage, error) {
		raw, _ := json.Marshal(payload)
		var req map[string]any
		_ = json.Unmarshal(raw, &req)
		if req["error_detail"].(map[string]any)["http_status"] != float64(502) {
			t.Fatal("unknown error status lost")
		}
		return json.RawMessage(`{}`), nil
	})
	defer hostbridge.Configure(nil)
	closeStreamFailure("callback", "stream", errors.New("fixture failure"))
}
