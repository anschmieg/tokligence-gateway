package opencode

import (
	"encoding/json"
	"testing"
)

// Native opencode.ts applies model.enabled = !config.disabled after merging
// model configuration. An operator allowlist must not reverse that restriction.
func TestConsoleDisabledModelPublicationAndDispatch(t *testing.T) {
	transport := &fakeTransport{}
	h := newTestHandler(t, transport)
	defer h.Shutdown()
	if err := h.Configure([]byte(testConfigYAML + "\nconsole_disabled_models: [beam-free, not-in-local-allowlist, beam-free]\n")); err != nil {
		t.Fatal(err)
	}
	cfg := h.WithConfigured()
	if len(cfg.ConsoleDisabledModels) != 2 {
		t.Fatal("snapshot was not deduplicated")
	}
	cfg.ConsoleDisabledModels[0] = "changed-outside-handler"
	for _, method := range []string{"model.register", "model.for_auth"} {
		request, _ := json.Marshal(map[string]any{"AuthProvider": ProviderKey, "StorageJSON": []byte(validCredential)})
		raw, err := h.HandleMethod(method, request)
		if err != nil {
			t.Fatal(err)
		}
		var result PluginModels
		if err := json.Unmarshal(decodeOKEnvelope(t, raw), &result); err != nil {
			t.Fatal(err)
		}
		if len(result.Models) != 1 || result.Models[0].ID != "glm-5.3-flash-free" {
			t.Fatalf("disabled model published through %s", method)
		}
	}
	for _, method := range []string{"executor.execute", "executor.execute_stream"} {
		_, err := h.HandleMethod(method, configLifecycleRequest(method == "executor.execute_stream"))
		if statusOf(err) != 404 {
			t.Fatalf("%s: wanted local404, got %v", method, err)
		}
	}
	if len(transport.doCalls) != 0 || len(transport.doStreamCalls) != 0 {
		t.Fatal("disabled model dispatched")
	}
	if h.WithConfigured().ModelAllowed("not-in-local-allowlist") {
		t.Fatal("Console snapshot expanded local admission")
	}
}

func TestAllConsoleDisabledModelsPublishEmptyCatalog(t *testing.T) {
	cfg, err := DecodeConfig([]byte(testConfigYAML + "\nconsole_disabled_models: [beam-free, glm-5.3-flash-free]\n"))
	if err != nil {
		t.Fatal(err)
	}
	models, err := BuildModelCatalog(cfg)
	if err != nil || len(models) != 0 {
		t.Fatalf("all disabled should publish no models: %v %v", models, err)
	}
}

func TestInvalidConsoleModelPolicyLeavesExistingConfig(t *testing.T) {
	h := newTestHandler(t, nil)
	defer h.Shutdown()
	for _, value := range []string{`[""]`, `[" beam-free"]`, `["beam-free\n"]`, `[null]`} {
		if err := h.Configure([]byte(testConfigYAML + "\nconsole_disabled_models: " + value)); err == nil {
			t.Fatalf("invalid policy accepted: %s", value)
		}
		if !h.WithConfigured().ModelAllowed("beam-free") {
			t.Fatal("invalid reconfigure changed admission")
		}
	}
}
