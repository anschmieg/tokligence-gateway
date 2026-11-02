package opencode

import (
	"encoding/json"
	"testing"
)

func TestConsoleInferenceOrganizationOverlay(t *testing.T) {
	credential, err := ParseCredential([]byte(validCredential))
	if err != nil {
		t.Fatal(err)
	}
	metadata, _ := credential.CredentialMetadata()
	base := InferenceHeaders(DefaultAppInfo(), "session", "session", "global", credential.Authorization())
	got, err := consoleInferenceHeaders(base, map[string]string{"x-opencode-org-id": metadata.OrgID}, credential)
	if err != nil {
		t.Fatal(err)
	}
	if got["x-opencode-org-id"][0] != metadata.OrgID || got["authorization"][0] != credential.Authorization() {
		t.Fatal("Console overlay lost or authentication replaced")
	}
	if _, exists := got["x-org-id"]; exists {
		t.Fatal("Console API organization header leaked into inference")
	}
	if _, err := consoleInferenceHeaders(base, map[string]string{"x-opencode-org-id": "other-org"}, credential); err == nil {
		t.Fatal("cross-org overlay accepted")
	}
}

func TestConsoleHeaderConfigurationAndCallerIsolation(t *testing.T) {
	for _, config := range []string{
		"console_headers:\n  Authorization: injected\n",
		"console_headers:\n  x-org: \"bad\\r\\nheader\"\n",
		"console_headers:\n  x-org: first\n  X-Org: second\n",
	} {
		if _, err := DecodeConfig([]byte(config)); err == nil {
			t.Fatal("unsafe Console header accepted")
		}
	}
	transport := &fakeTransport{doResult: HTTPResult{StatusCode: 200, Body: []byte(fixtureTextSSE)}}
	handler := newTestHandler(t, transport)
	credential, _ := ParseCredential([]byte(validCredential))
	metadata, _ := credential.CredentialMetadata()
	if err := handler.Configure([]byte(testConfigYAML + "\nconsole_headers:\n  x-opencode-org-id: " + metadata.OrgID + "\n")); err != nil {
		t.Fatal(err)
	}
	snapshot := handler.WithConfigured()
	snapshot.ConsoleHeaders["x-opencode-org-id"] = "other-org"
	var request map[string]any
	json.Unmarshal(configLifecycleRequest(false), &request)
	request["Headers"] = map[string][]string{"x-opencode-org-id": {"caller-must-not-override"}}
	raw, _ := json.Marshal(request)
	if _, err := handler.HandleMethod("executor.execute", raw); err != nil {
		t.Fatal(err)
	}
	if len(transport.doCalls) != 1 || transport.doCalls[0].Headers["x-opencode-org-id"][0] != metadata.OrgID {
		t.Fatal("trusted native Console overlay not applied at dispatch")
	}
	handler.Shutdown()
}
