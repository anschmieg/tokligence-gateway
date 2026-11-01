package opencode

import (
	"encoding/json"
	"testing"
)

func TestMalformedDispatchControlsFailBeforeHostHTTP(t *testing.T) {
	for _, payload := range []string{
		`null`, `[]`, `{"n":2}`, `{"n":null}`, `{"n":1.5}`,
		`{"max_tokens":0}`, `{"max_tokens":-1}`, `{"max_tokens":"1024"}`,
		`{"max_completion_tokens":null}`, `{"max_completion_tokens":1.5}`,
		`{"max_tokens":100,"max_completion_tokens":100}`,
		`{"stream_options":null}`, `{"stream_options":[]}`, `{"stream_options":{}}`,
		`{"stream_options":{"include_usage":null}}`, `{"stream_options":{"include_usage":"true"}}`,
	} {
		t.Run(payload, func(t *testing.T) {
			for _, stream := range []bool{false, true} {
				transport := &fakeTransport{}
				h := newTestHandler(t, transport)
				var req map[string]any
				if err := json.Unmarshal(configLifecycleRequest(stream), &req); err != nil {
					t.Fatal(err)
				}
				req["Payload"] = []byte(payload)
				raw, _ := json.Marshal(req)
				method := "executor.execute"
				if stream {
					method = "executor.execute_stream"
				}
				_, err := h.HandleMethod(method, raw)
				if statusOf(err) != 400 {
					t.Fatalf("stream=%v: status=%d err=%v", stream, statusOf(err), err)
				}
				if len(transport.doCalls)+len(transport.doStreamCalls) != 0 {
					t.Fatal("malformed controls reached HTTP")
				}
				if h.registry.Stats().Active != 0 {
					t.Fatal("local refusal leaked session lease")
				}
				h.Shutdown()
			}
		})
	}
}

func TestValidDispatchControlsKeepCallerSemantics(t *testing.T) {
	for _, payload := range []string{
		`{"n":1,"max_tokens":1024,"stream_options":{"include_usage":false,"future_option":true}}`,
		`{"max_completion_tokens":1024,"reasoning_effort":"low"}`,
	} {
		shaped, err := shapeInferenceRequest([]byte(payload), "beam-free")
		if err != nil {
			t.Fatal(err)
		}
		var before, after map[string]json.RawMessage
		json.Unmarshal([]byte(payload), &before)
		json.Unmarshal(shaped, &after)
		for key, want := range before {
			if string(after[key]) != string(want) {
				t.Fatalf("rewrote %s: got %s want %s", key, after[key], want)
			}
		}
	}
}
