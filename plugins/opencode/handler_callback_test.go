package opencode

import (
	"encoding/json"
	"fmt"
	"testing"
)

// Exercise handler -> actual bridge serialization -> raw host result, not a
// fake Transport that could conceal missing callback context.
func TestHandlerForwardsCallbackIDForAllHTTPPaths(t *testing.T) {
	for _, method := range []string{"executor.execute", "executor.execute_stream", "auth.refresh", "executor.http_request"} {
		t.Run(method, func(t *testing.T) {
			host := &recordingHost{handle: func(callback string, payload []byte) ([]byte, error) {
				switch callback {
				case "host.http.do", "host.http.do_stream":
					req := decodePayload(t, payload)
					if req["host_callback_id"] != "cb-handler" {
						return nil, fmt.Errorf("handler lost callback ID")
					}
					if callback == "host.http.do_stream" {
						return []byte(`{"status_code":429,"stream_id":"rejected-stream"}`), nil
					}
					body := []byte(`{"ok":true}`)
					if method == "executor.execute" {
						body = []byte(fixtureTextSSE)
					}
					if method == "auth.refresh" {
						body = []byte(`{"access_token":"fake-new","refresh_token":"fake-refresh","expires_in":3600}`)
					}
					return json.Marshal(hostHTTPDoResponse{StatusCode: 200, Body: body})
				case "host.http.stream_read":
					return []byte(`{"done":true}`), nil
				case "host.http.stream_close":
					return []byte(`{}`), nil
				default:
					return nil, fmt.Errorf("unexpected callback %s", callback)
				}
			}}
			h := newTestHandler(t, NewHostBridge(host.call))
			var req map[string]any
			_ = json.Unmarshal(configLifecycleRequest(method == "executor.execute_stream"), &req)
			req["host_callback_id"] = "cb-handler"
			req["Method"] = "GET"
			req["URL"] = "https://opencode.ai/console/api/v2/config"
			raw, _ := json.Marshal(req)
			_, err := h.HandleMethod(method, raw)
			if method == "executor.execute_stream" {
				if statusOf(err) != 429 {
					t.Fatalf("stream rejection = %v", err)
				}
			} else if err != nil {
				t.Fatal(err)
			}
			if host.countMethods("host.http.do")+host.countMethods("host.http.do_stream") != 1 {
				t.Fatal("expected exactly one HTTP callback")
			}
			if h.registry.Stats().Active != 0 {
				t.Fatal("handler leaked registry lease")
			}
		})
	}
}

func TestHostBridgeRejectsMalformedRawHTTPResults(t *testing.T) {
	for _, raw := range []string{"", "null", `{}`, `{"ok":true,"result":{"StatusCode":200}}`} {
		host := &recordingHost{handle: func(string, []byte) ([]byte, error) { return []byte(raw), nil }}
		h := newTestHandler(t, NewHostBridge(host.call))
		var req map[string]any
		_ = json.Unmarshal(configLifecycleRequest(false), &req)
		req["host_callback_id"] = "cb-handler"
		request, _ := json.Marshal(req)
		if _, err := h.HandleMethod("executor.execute", request); err == nil {
			t.Fatalf("malformed raw result accepted: %q", raw)
		}
		if h.registry.Stats().Active != 0 {
			t.Fatal("malformed result leaked lease")
		}
	}
}
