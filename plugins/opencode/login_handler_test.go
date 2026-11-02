package opencode

import (
	"encoding/json"
	"testing"
)

// Exercise the actual RPC handler and raw-result host bridge together. These
// requests use the pinned SDK's Go-name fields, not an invented HTTP contract.
func TestDeviceLoginStartThroughHostCallback(t *testing.T) {
	host := &recordingHost{}
	host.handle = func(method string, raw []byte) ([]byte, error) {
		if method != "host.http.do" {
			t.Fatalf("unexpected callback %s", method)
		}
		var req struct {
			Callback string `json:"host_callback_id"`
			Method   string `json:"method"`
			URL      string `json:"url"`
			Body     []byte `json:"body"`
		}
		if err := json.Unmarshal(raw, &req); err != nil {
			t.Fatal(err)
		}
		if req.Callback != "start-callback" || req.Method != "POST" || req.URL != DefaultConsoleServer+"/auth/device/code" {
			t.Fatal("incorrect callback identity or Console endpoint")
		}
		var body map[string]any
		if err := json.Unmarshal(req.Body, &body); err != nil {
			t.Fatal(err)
		}
		if body["client_id"] != ClientID || body["supports_org_scope"] != true {
			t.Fatal("incorrect native device request")
		}
		return json.Marshal(map[string]any{"StatusCode": 200, "Body": []byte(`{"device_code":"private-device-code","user_code":"ABCD-EFGH","verification_uri_complete":"https://opencode.ai/console/device?user_code=ABCD-EFGH","expires_in":600,"interval":5}`)})
	}
	h := newTestHandler(t, NewHostBridge(host.call))
	defer h.Shutdown()
	raw, err := h.HandleMethod("auth.login.start", []byte(`{"Provider":"opencode","BaseURL":"https://gateway.invalid/callback","host_callback_id":"start-callback"}`))
	if err != nil {
		t.Fatal(err)
	}
	var response struct{ Provider, URL, State string }
	if err := json.Unmarshal(decodeOKEnvelope(t, raw), &response); err != nil {
		t.Fatal(err)
	}
	if response.Provider != ProviderKey || response.URL == "" || response.State == "" || response.State == "private-device-code" {
		t.Fatal("invalid host login response")
	}
	if host.countMethods("host.http.do") != 1 {
		t.Fatal("login start must make exactly one Console request")
	}
	request, _ := json.Marshal(map[string]string{"Provider": ProviderKey, "State": response.State, "host_callback_id": "poll-callback"})
	raw, err = h.HandleMethod("auth.login.poll", request)
	if err != nil {
		t.Fatal(err)
	}
	var poll struct{ Status string }
	if err := json.Unmarshal(decodeOKEnvelope(t, raw), &poll); err != nil {
		t.Fatal(err)
	}
	if poll.Status != "pending" || host.countMethods("host.http.do") != 1 {
		t.Fatal("early poll must wait locally without HTTP")
	}
}

func TestDeviceLoginRejectsForeignProviderBeforeHTTP(t *testing.T) {
	transport := &fakeTransport{}
	h := newTestHandler(t, transport)
	defer h.Shutdown()
	for _, method := range []string{"auth.login.start", "auth.login.poll"} {
		_, err := h.HandleMethod(method, []byte(`{"Provider":"other","host_callback_id":"cb"}`))
		if err == nil || statusOf(err) != 400 {
			t.Fatal("foreign provider must be refused")
		}
	}
	if len(transport.doCalls) != 0 {
		t.Fatal("foreign login reached transport")
	}
}
