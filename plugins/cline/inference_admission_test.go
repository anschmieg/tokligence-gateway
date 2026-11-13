package cline

import (
	"encoding/json"
	"testing"
	"time"
)

func TestInferenceCredentialAdmissionBoundary(t *testing.T) {
	now := time.Date(2026, 11, 2, 0, 0, 0, 0, time.UTC)
	for _, delta := range []time.Duration{-time.Second, 0, time.Second} {
		raw, _ := json.Marshal(Storage{AccessToken: "fake-access", RefreshToken: "fake-refresh", ExpiresAt: now.Add(delta).Format(time.RFC3339)})
		_, err := admitInferenceCredential(ProviderKey, raw, now)
		if (err == nil) != (delta > 0) {
			t.Fatalf("delta=%s error=%v", delta, err)
		}
	}
}

func TestInferenceAdmissionRejectsBeforeEitherHostTransport(t *testing.T) {
	for _, stream := range []bool{false, true} {
		for _, provider := range []string{ProviderKey, "foreign"} {
			transport := &fakeTransport{}
			handler := newConfiguredHandler(t, transport)
			hostCalls := 0
			handler.SetStreamDeps(&StreamDeps{Client: NewHostStreamClient(func(string, []byte) ([]byte, error) { hostCalls++; return nil, nil }), Bridge: &recordingBridge{}})
			expiry := "2000-01-01T00:00:00Z"
			if provider == "foreign" {
				expiry = "2050-01-01T00:00:00Z"
			}
			storage, _ := json.Marshal(Storage{AccessToken: "fake-access", RefreshToken: "fake-refresh", ExpiresAt: expiry})
			request := ExecutorStreamRequest{ExecutorRequest: ExecutorRequest{AuthProvider: provider, Model: "cline/gpt-x", Stream: stream, StorageJSON: storage, Payload: []byte(`{"messages":[{"role":"user","content":"fixture"}]}`)}, StreamID: "fixture-stream"}
			method := "executor.execute"
			if stream {
				method = "executor.execute_stream"
			}
			_, err := handler.HandleMethod(method, mustMarshal(t, request))
			want := 401
			if provider == "foreign" {
				want = 400
			}
			if se, ok := err.(*statusError); !ok || se.status != want {
				t.Fatalf("stream=%v provider=%s err=%v", stream, provider, err)
			}
			if len(transport.calls) != 0 || hostCalls != 0 {
				t.Fatal("refused credential reached host HTTP")
			}
		}
	}
}
